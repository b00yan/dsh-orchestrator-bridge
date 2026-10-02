import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir, hostname } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { JobManager } from './jobs.js'

const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

async function fixture(t, run = async () => ({ summary: 'complete' }), settings = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-jobs-'))
  const workspace = path.join(root, 'repo')
  await mkdir(workspace)
  execFileSync('git', ['init', '--quiet', workspace])
  const stateDir = path.join(root, 'state')
  const manager = await new JobManager({ stateDir, run, ...settings }).start()
  t.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true }) })
  const ticket = (idempotencyKey = 'key', extra = {}) => ({ idempotencyKey, task: 'Implement the requested change.', workspace, ownedPaths: ['src/example.js'], acceptance: 'Focused checks pass and changes stay in owned paths.', ...extra })
  return { manager, ticket, root, workspace, stateDir }
}

async function state(manager, id, expected) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const snapshot = await manager.status(id)
    if (snapshot.status === expected) return snapshot
    await manager.wait(id, snapshot.revision, 50)
  }
  assert.fail(`job did not reach ${expected}: ${JSON.stringify(await manager.status(id))}`)
}

const handoff = (job) => ({ outcome: 'budget_exhausted', summary: 'Partial implementation; next pass needs focused checks.', sessionId: `session-${job.id}`, usage: { tokens: 30 }, evidence: { terminal: 'blocked', steps: job.maxSteps, after: { sha256: 'checkpoint', bytes: 12 } } })

test('budget exhaustion is an evidence-preserving handoff without approval, replay, or a long wait', async (t) => {
  let calls = 0
  const { manager, ticket, stateDir } = await fixture(t, async (job) => { calls += 1; return handoff(job) })
  const job = await manager.submit(ticket('budget', { maxSteps: 2 }))
  const exhausted = await state(manager, job.id, 'budget_exhausted')
  assert.equal(exhausted.result.outcome, 'budget_exhausted')
  assert.equal(exhausted.result.evidence.steps, 2)
  assert.deepEqual(exhausted.stopReason, { code: 'STEP_BUDGET_EXHAUSTED' })
  for (const decision of ['approve', 'revise', 'reject']) await assert.rejects(manager.review({ id: job.id, decision, feedback: 'next' }), /awaiting_review/)
  const immediate = await Promise.race([manager.wait(job.id, exhausted.revision, 25000), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('handoff wait did not return promptly')), 200); timer.unref() })])
  assert.equal(immediate.status, 'budget_exhausted')
  assert.equal(calls, 1)
  assert.equal((await manager.cancel(job.id)).status, 'budget_exhausted')
  await manager.close()
  const next = await new JobManager({ stateDir, run: async () => assert.fail('handoff must never automatically rerun') }).start()
  try {
    assert.deepEqual(await next.status(job.id), JSON.parse(JSON.stringify(exhausted)))
    assert.equal((await next.submit(ticket('budget', { maxSteps: 2 }))).id, job.id)
  } finally { await next.close() }
})

test('continuation is an immutable linked child, idempotent under concurrency and effective defaults', async (t) => {
  const runs = []
  const validated = []
  const { manager, ticket } = await fixture(t, async (job) => {
    runs.push(job)
    return job.continuation ? { outcome: 'completed', summary: 'Checks passed', evidence: { checked: true } } : handoff(job)
  }, { validateContinuation: async (parent) => { validated.push(parent.id); parent.result.summary = 'Callback mutation must not leak' } })
  const initial = await manager.submit(ticket('parent', { maxSteps: 3, timeoutMs: 2000 }))
  const parent = await state(manager, initial.id, 'budget_exhausted')
  const request = { id: parent.id, idempotencyKey: 'child', feedback: 'Complete the remaining check.' }
  const [first, second] = await Promise.all([manager.continue(request), manager.continue({ ...request, maxSteps: 3, timeoutMs: 2000 })])
  assert.equal(first.id, second.id)
  assert.notEqual(first.id, parent.id)
  assert.deepEqual(first.continuation, { parentJobId: parent.id, depth: 1 })
  const child = await state(manager, first.id, 'awaiting_review')
  for (const key of ['task', 'workspace', 'ownedPaths', 'acceptance', 'maxSteps', 'timeoutMs']) assert.deepEqual(child[key], parent[key])
  assert.deepEqual(child.continuation, { parentJobId: parent.id, depth: 1, feedback: request.feedback, previousResult: parent.result })
  assert.deepEqual(runs[1].continuation.previousResult, parent.result)
  assert.deepEqual(await manager.status(parent.id), parent)
  assert.deepEqual(validated, [parent.id])
  assert.equal(runs.length, 2)
  for (const changed of [{ feedback: 'Different plan' }, { maxSteps: 4 }, { timeoutMs: 3000 }]) await assert.rejects(manager.continue({ ...request, ...changed }), /different continuation request/)
  await assert.rejects(manager.continue({ ...request, idempotencyKey: 'second-child' }), /already has a continuation child/)
  await assert.rejects(manager.submit({ ...ticket('child'), maxSteps: 3, timeoutMs: 2000 }), /different ticket/)
  assert.equal((await manager.review({ id: child.id, decision: 'approve' })).status, 'approved')
  assert.deepEqual(await manager.status(parent.id), parent)
  const another = await manager.submit(ticket('another-parent', { maxSteps: 3, timeoutMs: 2000 }))
  await state(manager, another.id, 'budget_exhausted')
  await assert.rejects(manager.continue({ ...request, id: another.id }), /different continuation request/)
  assert.deepEqual(validated, [parent.id])
})

test('competing continuation keys atomically create only one child with explicitly chosen bounded limits', async (t) => {
  let validations = 0
  const { manager, ticket } = await fixture(t, async (job) => job.continuation ? { summary: 'complete' } : handoff(job), { validateContinuation: async () => { validations += 1 } })
  const initial = await manager.submit(ticket('parent'))
  const parent = await state(manager, initial.id, 'budget_exhausted')
  const request = { id: parent.id, feedback: 'Use the explicitly reviewed limits.', maxSteps: 100, timeoutMs: 3600000 }
  const outcomes = await Promise.allSettled([manager.continue({ ...request, idempotencyKey: 'first' }), manager.continue({ ...request, idempotencyKey: 'second' })])
  assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1)
  assert.match(outcomes.find((result) => result.status === 'rejected').reason.message, /already has a continuation child/)
  const child = await state(manager, outcomes.find((result) => result.status === 'fulfilled').value.id, 'awaiting_review')
  assert.equal(child.maxSteps, 100)
  assert.equal(child.timeoutMs, 3600000)
  assert.equal(validations, 1)
  assert.equal((await manager.list()).length, 2)
  assert.deepEqual(await manager.status(parent.id), parent)
})

test('continuation eligibility, explicit limits, feedback and checkpoint refusal never enqueue work', async (t) => {
  let checkpointCalls = 0
  const { manager, ticket } = await fixture(t, async (job) => job.idempotencyKey === 'complete' ? { summary: 'complete' } : handoff(job), {
    validateContinuation: async () => { checkpointCalls += 1; throw new Error('Checkpoint changed since the parent handoff') },
  })
  const initial = await manager.submit(ticket('parent'))
  const parent = await state(manager, initial.id, 'budget_exhausted')
  const request = { id: parent.id, idempotencyKey: 'child', feedback: 'Continue after review.' }
  for (const extra of [{ feedback: '' }, { feedback: 7 }, { maxSteps: 0 }, { maxSteps: 101 }, { maxSteps: null }, { timeoutMs: 0 }, { timeoutMs: 3600001 }, { timeoutMs: null }, { task: 'change scope' }, { workspace: '/another' }, { acceptance: 'weaker' }]) await assert.rejects(manager.continue({ ...request, ...extra }))
  await assert.rejects(manager.continue(request), /Checkpoint changed/)
  assert.equal(checkpointCalls, 1)
  assert.equal((await manager.list()).length, 1)
  assert.deepEqual(await manager.status(parent.id), parent)
  const complete = await manager.submit(ticket('complete'))
  await state(manager, complete.id, 'awaiting_review')
  await assert.rejects(manager.continue({ ...request, id: complete.id }), /only budget_exhausted/)
  await assert.rejects(manager.continue({ ...request, id: 'absent' }), /unknown job/)
  assert.throws(() => new JobManager({ stateDir: '/tmp/unused', run() {}, validateContinuation: true }), /validateContinuation/)
})

test('continuation has at most three explicit hops with no automatic budget increase', async (t) => {
  const { manager, ticket } = await fixture(t, async (job) => handoff(job))
  let current = await manager.submit(ticket('root', { maxSteps: 2, timeoutMs: 2000 }))
  await state(manager, current.id, 'budget_exhausted')
  for (let depth = 1; depth <= 3; depth += 1) {
    current = await manager.continue({ id: current.id, idempotencyKey: `hop-${depth}`, feedback: `Pass ${depth}` })
    const child = await state(manager, current.id, 'budget_exhausted')
    assert.equal(child.continuation.depth, depth)
    assert.equal(child.maxSteps, 2)
    assert.equal(child.timeoutMs, 2000)
  }
  await assert.rejects(manager.continue({ id: current.id, idempotencyKey: 'hop-4', feedback: 'Too far' }), /continuation depth/)
  assert.equal((await manager.list()).length, 4)
})

test('restart interrupts a running continuation; its retry returns the child without checkpoint revalidation or replay', async (t) => {
  const stopped = deferred()
  const { manager, ticket, stateDir } = await fixture(t, async (job) => job.continuation ? stopped.promise : handoff(job))
  const initial = await manager.submit(ticket('parent'))
  const parent = await state(manager, initial.id, 'budget_exhausted')
  const request = { id: parent.id, idempotencyKey: 'child', feedback: 'Continue the planned checks.' }
  const child = await manager.continue(request)
  await state(manager, child.id, 'running')
  const crashBytes = await readFile(path.join(stateDir, 'jobs.json'))
  const closing = manager.close()
  stopped.resolve({ summary: 'Stopped' })
  await closing
  await writeFile(path.join(stateDir, 'jobs.json'), crashBytes)
  const next = await new JobManager({ stateDir, run: async () => assert.fail('crashed child must not rerun'), validateContinuation: async () => assert.fail('idempotent retry must not revalidate an old checkpoint') }).start()
  try {
    const interrupted = await next.status(child.id)
    assert.equal(interrupted.status, 'interrupted')
    assert.equal(interrupted.stopReason.code, 'INTERRUPTED')
    assert.deepEqual(interrupted.continuation.previousResult, parent.result)
    assert.equal((await next.continue(request)).id, child.id)
    assert.deepEqual(await next.status(parent.id), JSON.parse(JSON.stringify(parent)))
  } finally { await next.close() }
})

test('running continuation cancellation retains evidence and cannot change or re-continue its parent', async (t) => {
  const started = deferred()
  const stopped = deferred()
  let current
  const { manager, ticket } = await fixture(t, async (job, { signal }) => {
    if (!job.continuation) return handoff(job)
    current = job
    signal.addEventListener('abort', () => stopped.resolve(handoff(job)), { once: true })
    started.resolve()
    return stopped.promise
  })
  const initial = await manager.submit(ticket('parent'))
  const parent = await state(manager, initial.id, 'budget_exhausted')
  const child = await manager.continue({ id: parent.id, idempotencyKey: 'child', feedback: 'Continue' })
  await started.promise
  const cancelled = await manager.cancel(child.id)
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.stopReason.code, 'CANCELLED')
  const partial = handoff(current)
  delete partial.outcome
  assert.deepEqual(cancelled.result, partial)
  assert.equal(cancelled.result.outcome, undefined)
  await assert.rejects(manager.review({ id: child.id, decision: 'approve' }), /awaiting_review/)
  await assert.rejects(manager.continue({ id: child.id, idempotencyKey: 'grandchild', feedback: 'Again' }), /only budget_exhausted/)
  assert.deepEqual(await manager.status(parent.id), parent)
  await assert.rejects(manager.continue({ id: parent.id, idempotencyKey: 'replacement', feedback: 'Again' }), /already has a continuation child/)
})

test('a queued continuation can be cancelled without execution or a replacement child', async (t) => {
  const blocker = deferred()
  const { manager, ticket } = await fixture(t, async (job) => {
    if (job.continuation) assert.fail('cancelled queued continuation must not execute')
    return job.idempotencyKey === 'blocker' ? blocker.promise : handoff(job)
  })
  const initial = await manager.submit(ticket('parent'))
  const parent = await state(manager, initial.id, 'budget_exhausted')
  const active = await manager.submit(ticket('blocker'))
  await state(manager, active.id, 'running')
  const request = { id: parent.id, idempotencyKey: 'child', feedback: 'Preserve the checkpoint.' }
  const child = await manager.continue(request)
  assert.equal(child.status, 'queued')
  const cancelled = await manager.cancel(child.id)
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.stopReason.code, 'CANCELLED')
  assert.equal((await manager.continue(request)).id, child.id)
  await assert.rejects(manager.continue({ ...request, idempotencyKey: 'replacement' }), /already has a continuation child/)
  assert.deepEqual(await manager.status(parent.id), parent)
  blocker.resolve({ summary: 'blocker stopped' })
  await state(manager, active.id, 'awaiting_review')
})

test('continuations respect retention capacity without running checkpoint validation', async (t) => {
  const { manager, ticket } = await fixture(t, async (job) => handoff(job), { maxJobs: 1, validateContinuation: async () => assert.fail('full queue must refuse before checkpoint validation') })
  const initial = await manager.submit(ticket('parent'))
  const parent = await state(manager, initial.id, 'budget_exhausted')
  await assert.rejects(manager.continue({ id: parent.id, idempotencyKey: 'child', feedback: 'Continue' }), /retention limit/)
  assert.deepEqual(await manager.status(parent.id), parent)
})

test('only exact evidenced legacy budget failures become handoffs on load', async (t) => {
  const { manager, ticket, stateDir } = await fixture(t, async (job) => {
    const error = new Error(job.idempotencyKey === 'message' ? 'Different failure' : 'Worker exhausted its model-step budget')
    error.result = { summary: 'Partial old worker result', evidence: { terminal: job.idempotencyKey === 'terminal' ? 'error' : 'blocked', steps: job.idempotencyKey === 'steps' ? job.maxSteps - 1 : job.maxSteps } }
    throw error
  })
  const ids = {}
  for (const key of ['exact', 'message', 'terminal', 'steps']) {
    ids[key] = (await manager.submit(ticket(key))).id
    await state(manager, ids[key], 'failed')
  }
  await manager.close()
  const old = JSON.parse(await readFile(path.join(stateDir, 'jobs.json'), 'utf8'))
  for (const job of old.jobs) delete job.stopReason
  await writeFile(path.join(stateDir, 'jobs.json'), JSON.stringify(old))
  const next = await new JobManager({ stateDir, run: async () => assert.fail('legacy work must not replay') }).start()
  try {
    const exact = await next.status(ids.exact)
    assert.equal(exact.status, 'budget_exhausted')
    assert.equal(exact.stopReason.code, 'STEP_BUDGET_EXHAUSTED')
    assert.deepEqual(exact.result, old.jobs[0].result)
    for (const key of ['message', 'terminal', 'steps']) assert.equal((await next.status(ids[key])).status, 'failed')
    await assert.rejects(next.review({ id: exact.id, decision: 'approve' }), /awaiting_review/)
  } finally { await next.close() }
})

test('persisted continuation chains refuse missing parents, duplicate children, cycles, depth and scope corruption', async (t) => {
  const { manager, ticket, stateDir } = await fixture(t, async (job) => handoff(job))
  const root = await manager.submit(ticket('root'))
  await state(manager, root.id, 'budget_exhausted')
  const child = await manager.continue({ id: root.id, idempotencyKey: 'child', feedback: 'Continue' })
  await state(manager, child.id, 'budget_exhausted')
  const grandchild = await manager.continue({ id: child.id, idempotencyKey: 'grandchild', feedback: 'Continue again' })
  await state(manager, grandchild.id, 'budget_exhausted')
  await manager.close()
  const valid = JSON.parse(await readFile(path.join(stateDir, 'jobs.json'), 'utf8'))
  const rehash = (job) => { job.fingerprint = createHash('sha256').update(JSON.stringify(job.continuation ? { ticket: job.ticket, continuation: job.continuation } : job.ticket)).digest('hex') }
  const corruptions = [
    (state) => { state.jobs[1].continuation.parentJobId = randomUUID(); rehash(state.jobs[1]) },
    (state) => { const extra = structuredClone(state.jobs[1]); extra.id = randomUUID(); extra.ticket.idempotencyKey = 'duplicate'; rehash(extra); state.jobs.push(extra) },
    (state) => { state.jobs[1].continuation.depth = 3; rehash(state.jobs[1]) },
    (state) => { state.jobs[1].ticket.task = 'Different scope'; rehash(state.jobs[1]) },
    (state) => { state.jobs[0].continuation = { parentJobId: child.id, depth: 2, feedback: 'Cycle' }; rehash(state.jobs[0]) },
    (state) => { state.jobs[1].continuation.previousResult = {}; rehash(state.jobs[1]) },
    (state) => { state.jobs[0].status = 'failed' },
    (state) => { state.jobs[0].status = 'approved' },
    (state) => { state.jobs[0].stopReason = { code: 'invalid secret value' } },
  ]
  for (const corrupt of corruptions) {
    const damaged = structuredClone(valid)
    corrupt(damaged)
    const bytes = JSON.stringify(damaged)
    await writeFile(path.join(stateDir, 'jobs.json'), bytes)
    await assert.rejects(new JobManager({ stateDir, run: async () => assert.fail('corrupt chains must not execute') }).start(), /Cannot load job state/)
    assert.equal(await readFile(path.join(stateDir, 'jobs.json'), 'utf8'), bytes)
  }
})

test('failed runner codes and invalid outcomes stay failures, never completion or handoff', async (t) => {
  const { manager, ticket } = await fixture(t, async (job) => {
    if (job.idempotencyKey === 'outcome') return { summary: 'Invalid outcome', outcome: 'approved' }
    const error = new Error('Provider refused')
    error.code = job.idempotencyKey === 'safe' ? 'TRANSPORT' : 'Bearer arbitrary secret'
    throw error
  })
  for (const key of ['safe', 'unsafe', 'outcome']) {
    const job = await manager.submit(ticket(key))
    const failed = await state(manager, job.id, 'failed')
    assert.equal(failed.stopReason.code, key === 'safe' ? 'TRANSPORT' : 'RUNNER_FAILED')
    await assert.rejects(manager.review({ id: job.id, decision: 'approve' }), /awaiting_review/)
    await assert.rejects(manager.continue({ id: job.id, idempotencyKey: 'child', feedback: 'Continue' }), /only budget_exhausted/)
  }
})

test('idempotency is canonical, concurrent, durable, and refuses changed parameters', async (t) => {
  let calls = 0
  const { manager, ticket, workspace, root, stateDir } = await fixture(t, async () => { calls += 1; return { summary: 'done' } })
  const alias = path.join(root, 'alias')
  await symlink(workspace, alias)
  const original = ticket('same', { ownedPaths: ['src/b.js', './src/a.js', 'src/a.js'] })
  const [first, second] = await Promise.all([
    manager.submit(original),
    manager.submit(ticket('same', { workspace: alias, ownedPaths: ['src/a.js', 'src/b.js'] })),
  ])
  assert.equal(first.id, second.id)
  await state(manager, first.id, 'awaiting_review')
  assert.equal(calls, 1)
  for (const extra of [{ task: 'different' }, { acceptance: 'different' }, { maxSteps: 13 }, { timeoutMs: 5000 }, { ownedPaths: ['other.js'] }]) await assert.rejects(manager.submit({ ...original, ...extra }), /different ticket/)
  assert.equal((await stat(path.join(stateDir, 'jobs.json'))).mode & 0o777, 0o600)
  await manager.close()
  const next = await new JobManager({ stateDir, run: async () => assert.fail('idempotent retry must not rerun') }).start()
  try { assert.equal((await next.submit(original)).id, first.id) } finally { await next.close() }
})

test('only successful awaiting_review work can be approved; failures and rejection remain terminal', async (t) => {
  const gate = deferred()
  const { manager, ticket } = await fixture(t, (job) => job.idempotencyKey === 'bad' ? Promise.reject(new Error('focused checks failed')) : gate.promise)
  const good = await manager.submit(ticket('good'))
  await assert.rejects(manager.review({ id: good.id, decision: 'approve' }), /awaiting_review/)
  gate.resolve({ summary: 'verified', sessionId: 'session-1', evidence: { checks: ['passed'] }, usage: { tokens: 17 } })
  const ready = await state(manager, good.id, 'awaiting_review')
  assert.deepEqual(ready.result, { summary: 'verified', sessionId: 'session-1', usage: { tokens: 17 }, evidence: { checks: ['passed'] } })
  assert.equal((await manager.review({ id: good.id, decision: 'approve' })).status, 'approved')
  await assert.rejects(manager.review({ id: good.id, decision: 'revise', feedback: 'more' }), /awaiting_review/)
  const bad = await manager.submit(ticket('bad'))
  assert.equal((await state(manager, bad.id, 'failed')).error, 'focused checks failed')
  await assert.rejects(manager.review({ id: bad.id, decision: 'approve' }), /awaiting_review/)
  const rejected = await manager.submit(ticket('reject'))
  await state(manager, rejected.id, 'awaiting_review')
  assert.equal((await manager.review({ id: rejected.id, decision: 'reject', feedback: 'wrong scope' })).status, 'rejected')
  await assert.rejects(manager.review({ id: rejected.id, decision: 'approve' }), /awaiting_review/)
})

test('revisions reuse the job and retain original task/acceptance, bounded at two', async (t) => {
  const runs = []
  const { manager, ticket } = await fixture(t, async (job) => { runs.push(job); return { summary: `attempt ${runs.length}` } })
  const first = await manager.submit(ticket())
  await state(manager, first.id, 'awaiting_review')
  await assert.rejects(manager.review({ id: first.id, decision: 'revise' }), /requires feedback/)
  for (const feedback of ['repair the test', 'handle refusal']) {
    const revised = await manager.review({ id: first.id, decision: 'revise', feedback })
    assert.equal(revised.id, first.id)
    await state(manager, first.id, 'awaiting_review')
    const last = runs.at(-1)
    assert.equal(last.feedback, feedback)
    assert.equal(last.task, ticket().task)
    assert.equal(last.acceptance, ticket().acceptance)
  }
  assert.equal(runs.length, 3)
  await assert.rejects(manager.review({ id: first.id, decision: 'revise', feedback: 'again' }), /revision limit/)
  assert.equal((await manager.status(first.id)).status, 'awaiting_review')
})

for (const outcome of ['completed', 'budget_exhausted']) test(`failed workers preserve evidence while removing the reported ${outcome} outcome`, async (t) => {
  const failure = new Error('Validation failed after edits')
  failure.result = { outcome, summary: 'One check failed; review the diff.', sessionId: 'failed-session', usage: { tokens: 20 }, evidence: { artifactDir: '/local/evidence', changedPaths: ['src/example.js'], terminal: 'error' } }
  const { manager, ticket } = await fixture(t, async () => { throw failure })
  const job = await manager.submit(ticket())
  const failed = await state(manager, job.id, 'failed')
  const expected = { ...failure.result }
  delete expected.outcome
  assert.deepEqual(failed.result, expected)
  assert.equal(failed.result.outcome, undefined)
  assert.equal(failure.result.outcome, outcome)
  assert.equal(failed.error, failure.message)
  await assert.rejects(manager.review({ id: job.id, decision: 'approve' }), /awaiting_review/)
})

test('a failed revision retains prior evidence without retaining its previous completion outcome', async (t) => {
  const { manager, ticket } = await fixture(t, async (job) => {
    if (job.revisions > 0) throw new Error('Revised check failed before a new report')
    return { outcome: 'completed', summary: 'Original report', evidence: { artifactDir: '/local/prior-evidence' } }
  })
  const job = await manager.submit(ticket())
  const ready = await state(manager, job.id, 'awaiting_review')
  await manager.review({ id: job.id, decision: 'revise', feedback: 'Handle the refusal case.' })
  const failed = await state(manager, job.id, 'failed')
  assert.deepEqual(failed.result, { summary: 'Original report', evidence: ready.result.evidence })
  assert.equal(failed.result.outcome, undefined)
  assert.equal(ready.result.outcome, 'completed')
  await assert.rejects(manager.review({ id: job.id, decision: 'approve' }), /awaiting_review/)
})

test('the same physical workspace serializes even disjoint owned paths and symlink aliases', async (t) => {
  const started = []
  const gates = [deferred(), deferred()]
  const { manager, ticket, root, workspace } = await fixture(t, (job) => {
    started.push(job)
    return gates[started.length - 1].promise
  })
  const alias = path.join(root, 'alias')
  await symlink(workspace, alias)
  const first = await manager.submit(ticket('one', { ownedPaths: ['one.js'] }))
  const second = await manager.submit(ticket('two', { workspace: alias, ownedPaths: ['two.js'] }))
  await state(manager, first.id, 'running')
  assert.equal((await manager.status(second.id)).status, 'queued')
  assert.equal(started.length, 1)
  gates[0].resolve({ summary: 'one' })
  await state(manager, second.id, 'running')
  assert.equal(started.length, 2)
  gates[1].resolve({ summary: 'two' })
  await state(manager, second.id, 'awaiting_review')
})

test('independent Git worktrees run in parallel with the configured global bound', async (t) => {
  const gate = deferred()
  const started = []
  const { manager, ticket, root, workspace } = await fixture(t, (job) => { started.push(job.workspace); return gate.promise }, { maxParallel: 2 })
  execFileSync('git', ['-C', workspace, '-c', 'user.email=tests@example.invalid', '-c', 'user.name=Tests', 'commit', '--quiet', '--allow-empty', '-m', 'fixture'])
  const worktree = path.join(root, 'worktree')
  execFileSync('git', ['-C', workspace, 'worktree', 'add', '--quiet', '--detach', worktree])
  const thirdRepo = path.join(root, 'third')
  await mkdir(thirdRepo)
  execFileSync('git', ['init', '--quiet', thirdRepo])
  const first = await manager.submit(ticket('one'))
  const second = await manager.submit(ticket('two', { workspace: worktree }))
  const third = await manager.submit(ticket('three', { workspace: thirdRepo }))
  await state(manager, first.id, 'running')
  await state(manager, second.id, 'running')
  assert.equal((await manager.status(third.id)).status, 'queued')
  assert.equal(started.length, 2)
  gate.resolve({ summary: 'done' })
  await state(manager, third.id, 'awaiting_review')
  assert.equal(started.length, 3)
})

test('cancellation waits for runner cleanup and holds the workspace slot after abort', async (t) => {
  const started = []
  const stopped = deferred()
  const sawAbort = deferred()
  const { manager, ticket } = await fixture(t, (job, { signal }) => {
    started.push(job.id)
    if (started.length > 1) return { summary: 'second done' }
    signal.addEventListener('abort', () => sawAbort.resolve(), { once: true })
    return stopped.promise
  })
  const first = await manager.submit(ticket('one'))
  const second = await manager.submit(ticket('two'))
  await state(manager, first.id, 'running')
  let cancelFinished = false
  const cancelled = manager.cancel(first.id).then((snapshot) => { cancelFinished = true; return snapshot })
  await sawAbort.promise
  assert.equal(cancelFinished, false)
  assert.equal((await manager.status(first.id)).status, 'running')
  assert.equal((await manager.status(second.id)).status, 'queued')
  const cancellation = new Error('worker cleanup after abort')
  cancellation.result = { summary: 'Partial edits remain', sessionId: 'cancelled-session', evidence: { artifactDir: '/local/cancelled' } }
  stopped.reject(cancellation)
  const final = await cancelled
  assert.equal(final.status, 'cancelled')
  assert.deepEqual(final.result, cancellation.result)
  await assert.rejects(manager.review({ id: first.id, decision: 'approve' }), /awaiting_review/)
  await state(manager, second.id, 'awaiting_review')
  assert.equal(started.length, 2)
})

test('deadlines abort and fail without releasing the slot until the runner has stopped', async (t) => {
  const stopped = deferred()
  const aborted = deferred()
  let calls = 0
  const { manager, ticket } = await fixture(t, (_job, { signal }) => {
    calls += 1
    if (calls > 1) return { summary: 'second' }
    signal.addEventListener('abort', () => aborted.resolve(), { once: true })
    return stopped.promise
  })
  const first = await manager.submit(ticket('one', { timeoutMs: 15 }))
  const second = await manager.submit(ticket('two'))
  await aborted.promise
  assert.equal((await manager.status(second.id)).status, 'queued')
  assert.equal(calls, 1)
  stopped.reject(new Error('abort cleanup'))
  const deadline = await state(manager, first.id, 'failed')
  assert.match(deadline.error, /deadline/)
  assert.equal(deadline.stopReason.code, 'DEADLINE_EXCEEDED')
  await state(manager, second.id, 'awaiting_review')
  assert.equal(calls, 2)
})

for (const reason of ['cancel', 'deadline']) test(`${reason} retains a result returned after abort without allowing approval`, async (t) => {
  const stopped = deferred()
  const aborted = deferred()
  const outcome = reason === 'cancel' ? 'completed' : 'budget_exhausted'
  const result = { outcome, summary: 'Partial edits remain after cleanup.', sessionId: 'late-result-session', usage: { tokens: 12 }, evidence: { artifactDir: '/local/late-result', changedPaths: ['src/example.js'] } }
  const { manager, ticket } = await fixture(t, (_job, { signal }) => {
    signal.addEventListener('abort', () => aborted.resolve(), { once: true })
    return stopped.promise
  })
  const job = await manager.submit(ticket('late-result', { timeoutMs: reason === 'deadline' ? 15 : 5000 }))
  await state(manager, job.id, 'running')
  const cancelled = reason === 'cancel' ? manager.cancel(job.id) : undefined
  await aborted.promise
  assert.equal((await manager.status(job.id)).status, 'running')
  stopped.resolve(result)
  const final = cancelled ? await cancelled : await state(manager, job.id, 'failed')
  assert.equal(final.status, reason === 'cancel' ? 'cancelled' : 'failed')
  const expected = { ...result }
  delete expected.outcome
  assert.deepEqual(final.result, expected)
  assert.equal(final.result.outcome, undefined)
  assert.equal(result.outcome, outcome)
  if (reason === 'deadline') assert.match(final.error, /deadline/)
  await assert.rejects(manager.review({ id: job.id, decision: 'approve' }), /awaiting_review/)
})

test('queued cancellation prevents execution; close waits before releasing its owner lock', async (t) => {
  const stopped = deferred()
  const aborted = deferred()
  let calls = 0
  const { manager, ticket, stateDir } = await fixture(t, (_job, { signal }) => {
    calls += 1
    signal.addEventListener('abort', () => aborted.resolve(), { once: true })
    return stopped.promise
  })
  const first = await manager.submit(ticket('one'))
  await state(manager, first.id, 'running')
  const queued = await manager.submit(ticket('two'))
  assert.equal((await manager.cancel(queued.id)).status, 'cancelled')
  assert.equal(calls, 1)
  let finished = false
  const closing = manager.close().then(() => { finished = true })
  await aborted.promise
  assert.equal(finished, false)
  const competing = new JobManager({ stateDir, run: async () => ({ summary: 'never' }) })
  await assert.rejects(competing.start(), /live owner/)
  stopped.resolve({ outcome: 'completed', summary: 'late', evidence: { cleanup: true } })
  await closing
  const next = await new JobManager({ stateDir, run: async () => assert.fail('interrupted jobs must not run') }).start()
  try {
    const interrupted = await next.status(first.id)
    assert.equal(interrupted.status, 'interrupted')
    assert.equal(interrupted.stopReason.code, 'INTERRUPTED')
    assert.deepEqual(interrupted.result, { summary: 'late', evidence: { cleanup: true } })
    assert.equal(interrupted.result.outcome, undefined)
    assert.equal((await next.status(queued.id)).status, 'cancelled')
  } finally { await next.close() }
})

test('restart marks both queued and running durable jobs interrupted, without replay or data loss', async (t) => {
  const gate = deferred()
  const { manager, ticket, stateDir } = await fixture(t, () => gate.promise)
  const first = await manager.submit(ticket('one'))
  await state(manager, first.id, 'running')
  const second = await manager.submit(ticket('two'))
  const crashBytes = await readFile(path.join(stateDir, 'jobs.json'))
  gate.resolve({ summary: 'finished during orderly cleanup' })
  await manager.close()
  await writeFile(path.join(stateDir, 'jobs.json'), crashBytes)
  let calls = 0
  const next = await new JobManager({ stateDir, run: async () => { calls += 1; return { summary: 'bad' } } }).start()
  try {
    assert.equal((await next.status(first.id)).status, 'interrupted')
    assert.equal((await next.status(second.id)).status, 'interrupted')
    assert.equal((await next.submit(ticket('one'))).id, first.id)
    assert.equal(calls, 0)
  } finally { await next.close() }
})

test('malformed state refuses startup, keeps bytes, and releases only its own lock', async (t) => {
  const { manager, stateDir } = await fixture(t)
  await manager.close()
  for (const malformed of ['{broken', JSON.stringify({ version: 1, jobs: [{}] }), JSON.stringify({ version: 999, jobs: [] })]) {
    await writeFile(path.join(stateDir, 'jobs.json'), malformed)
    await assert.rejects(new JobManager({ stateDir, run: async () => ({ summary: 'unused' }) }).start(), /Cannot load job state/)
    assert.equal(await readFile(path.join(stateDir, 'jobs.json'), 'utf8'), malformed)
    await assert.rejects(stat(path.join(stateDir, 'owner.lock')), { code: 'ENOENT' })
  }
})

test('owner lock rejects live and malformed owners, and recovers a proven dead local PID', async (t) => {
  const { manager, stateDir } = await fixture(t)
  const contender = () => new JobManager({ stateDir, run: async () => ({ summary: 'unused' }) })
  await assert.rejects(contender().start(), /live owner/)
  await manager.close()
  const lockPath = path.join(stateDir, 'owner.lock')
  await writeFile(lockPath, JSON.stringify({ pid: 2147483647, host: hostname(), token: 'dead-owner' }), { mode: 0o600 })
  const recovered = await contender().start()
  await recovered.close()
  for (const bytes of ['{}', JSON.stringify({ pid: 2147483647, host: 'another-host', token: 'foreign-owner' })]) {
    await writeFile(lockPath, bytes)
    await assert.rejects(contender().start(), /malformed or belongs to another host/)
    assert.equal(await readFile(lockPath, 'utf8'), bytes)
    await rm(lockPath)
  }
})

test('persisted unknown fields, forged identity, duplicate jobs, and resultless approval refuse startup', async (t) => {
  const { manager, ticket, stateDir } = await fixture(t)
  const job = await manager.submit(ticket())
  await state(manager, job.id, 'awaiting_review')
  const valid = JSON.parse(await readFile(path.join(stateDir, 'jobs.json'), 'utf8'))
  await manager.close()
  const corruptions = [
    (state) => { state.jobs[0].unexpected = 'must not leak into snapshots' },
    (state) => { state.jobs[0].fingerprint = 'forged' },
    (state) => { state.jobs.push(structuredClone(state.jobs[0])) },
    (state) => { state.jobs[0].status = 'approved'; delete state.jobs[0].result },
    (state) => { state.jobs[0].result.summary = 'x'.repeat(16001) },
    (state) => { state.jobs[0].ticket.ownedPaths = ['../escape'] },
    (state) => { state.jobs[0].revisions = 3 },
  ]
  for (const corrupt of corruptions) {
    const damaged = structuredClone(valid)
    corrupt(damaged)
    const bytes = JSON.stringify(damaged)
    await writeFile(path.join(stateDir, 'jobs.json'), bytes)
    await assert.rejects(new JobManager({ stateDir, run: async () => assert.fail('must not execute') }).start(), /Cannot load job state/)
    assert.equal(await readFile(path.join(stateDir, 'jobs.json'), 'utf8'), bytes)
  }
})

test('tickets refuse unsafe paths, missing bounds, unknown fields, and non-root/non-Git workspaces', async (t) => {
  const { manager, ticket, root, workspace } = await fixture(t)
  const cases = [
    { task: '' }, { acceptance: '' }, { idempotencyKey: 42 }, { ownedPaths: [] },
    { ownedPaths: ['../secret'] }, { ownedPaths: ['src/../secret'] }, { ownedPaths: ['/absolute'] },
    { ownedPaths: ['C:/absolute'] }, { ownedPaths: ['src\\file.js'] }, { ownedPaths: ['.git/config'] },
    { ownedPaths: ['.'] }, { ownedPaths: ['\0bad'] }, { task: 'x'.repeat(16001) },
    { timeoutMs: 0 }, { timeoutMs: 3600001 }, { maxSteps: 0 }, { maxSteps: 101 },
    { maxSteps: '12' }, { random: 'unsupported' }, { workspace: path.join(root, 'absent') },
  ]
  for (const extra of cases) await assert.rejects(manager.submit(ticket('bad', extra)))
  const nested = path.join(workspace, 'subdir')
  await mkdir(nested)
  await assert.rejects(manager.submit(ticket('nested', { workspace: nested })), /root/)
  await assert.rejects(manager.submit(ticket('nongit', { workspace: root })))
  assert.equal((await manager.list()).length, 0)
  for (const config of [{ maxParallel: 0 }, { maxParallel: 9 }, { maxJobs: 0 }]) assert.throws(() => new JobManager({ stateDir: root, run() {}, ...config }))
})

test('retention bound never evicts idempotency history, and result payloads are bounded', async (t) => {
  const { manager, ticket } = await fixture(t, async () => ({ summary: 'x'.repeat(20000) }), { maxJobs: 1 })
  const job = await manager.submit(ticket())
  const ready = await state(manager, job.id, 'awaiting_review')
  assert.equal(ready.result.summary.length, 16000)
  const compactSummary = (await manager.list())[0].result.summary
  assert.equal(Buffer.byteLength(JSON.stringify(compactSummary)), 1000)
  assert.ok(compactSummary.endsWith('…'))
  assert.equal((await manager.submit(ticket())).id, job.id)
  await assert.rejects(manager.submit(ticket('next')), /retention limit/)
})

test('a full retained list of Unicode and escaped text fits MCP bytes while full status keeps evidence', async (t) => {
  const { manager, ticket, stateDir } = await fixture(t)
  for (let index = 0; index < 100; index += 1) await manager.submit(ticket(`unicode-${index}`))
  await manager.close()
  const stored = JSON.parse(await readFile(path.join(stateDir, 'jobs.json'), 'utf8'))
  const text = '汉"\\\n🙂'
  const summary = text.repeat(2000)
  const feedback = text.repeat(1000)
  const error = text.repeat(500).slice(0, 2000)
  const sessionId = text.repeat(35)
  const progress = { message: text.repeat(250) }
  for (const job of stored.jobs) Object.assign(job, {
    status: 'failed', revisions: 1, feedback, error, progress,
    result: { summary, sessionId, evidence: { artifactDir: '/local/complete-evidence' } },
  })
  // A completed retained state remains readable even after its checkout is gone.
  await writeFile(path.join(stateDir, 'jobs.json'), JSON.stringify(stored))
  const next = await new JobManager({ stateDir, run: async () => assert.fail('terminal retained jobs must not replay') }).start()
  try {
    const list = await next.list()
    assert.equal(list.length, 100)
    assert.ok(Buffer.byteLength(JSON.stringify(list)) < 1024 * 1024, 'default retained list must fit the MCP response cap')
    for (const [index, compact] of list.entries()) {
      assert.ok(Buffer.byteLength(JSON.stringify(compact)) <= 8192, 'every compact entry must fit its byte budget')
      assert.equal(compact.id, stored.jobs[index].id)
      assert.equal(compact.revision, stored.jobs[index].revision)
      assert.equal(compact.status, 'failed')
      for (const value of [compact.result.summary, compact.feedback, compact.error, compact.workspace]) assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 1000)
      assert.ok(Buffer.byteLength(JSON.stringify(compact.result.sessionId)) <= 256)
      assert.ok(Buffer.byteLength(JSON.stringify(compact.progress)) <= 1000)
      assert.equal(compact.progress.truncated, true)
    }
    const full = await next.status(list[0].id)
    assert.equal(full.result.summary, summary)
    assert.equal(full.result.sessionId, sessionId)
    assert.equal(full.feedback, feedback)
    assert.equal(full.error, error)
    assert.deepEqual(full.progress, progress)
    assert.deepEqual(full.result.evidence, { artifactDir: '/local/complete-evidence' })
  } finally { await next.close() }
})

test('progress persists and wait returns compact state, removes listeners, and enforces wait bounds', async (t) => {
  const gate = deferred()
  let onProgress
  const { manager, ticket, stateDir } = await fixture(t, async (_job, options) => { onProgress = options.onProgress; return gate.promise })
  const job = await manager.submit(ticket())
  const running = await state(manager, job.id, 'running')
  const waiting = manager.wait(job.id, running.revision, 1000)
  await onProgress({ message: 'focused checks', step: 2 })
  const changed = await waiting
  assert.equal(changed.task, undefined)
  assert.deepEqual(changed.progress, { message: 'focused checks', step: 2 })
  const disk = JSON.parse(await readFile(path.join(stateDir, 'jobs.json'), 'utf8'))
  assert.deepEqual(disk.jobs[0].progress, changed.progress)
  assert.equal(manager.listeners.size, 0)
  const timeout = await manager.wait(job.id, changed.revision, 1)
  assert.equal(timeout.revision, changed.revision)
  assert.equal(manager.listeners.size, 0)
  await assert.rejects(manager.wait(job.id, changed.revision, 25001), /waitMs/)
  await assert.rejects(manager.wait('absent', 0, 1), /unknown job/)
  await assert.rejects(onProgress('x'.repeat(5000)), /bounded JSON/)
  gate.resolve({ summary: 'done' })
  await state(manager, job.id, 'awaiting_review')
})

test('close promptly cleans pending wait listeners after a worker stops', async (t) => {
  const gate = deferred()
  const { manager, ticket } = await fixture(t, async () => gate.promise)
  const job = await manager.submit(ticket())
  const running = await state(manager, job.id, 'running')
  const waiting = manager.wait(job.id, running.revision, 25000)
  const rejected = assert.rejects(waiting, /not running/)
  gate.resolve({ summary: 'closing' })
  await manager.close()
  await rejected
  assert.equal(manager.listeners.size, 0)
})
