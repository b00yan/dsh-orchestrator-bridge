import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, readFile, writeFile, stat, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createBridge } from './server.js'
import { snapshot } from './runner.js'
import { createHash } from 'node:crypto'
const exec = promisify(execFile)
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
async function fixture(t, run = async () => ({ summary: 'Changed owned.txt; independent review required', sessionId: 'fake-session', evidence: { validation: 'worker_report_requires_independent_review' } })) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'bridge-server-')))
  const workspace = path.join(root, 'allowed', 'repo'), outside = path.join(root, 'outside'), stateDir = path.join(root, 'state')
  await mkdir(workspace, { recursive: true }); await mkdir(outside)
  for (const cwd of [workspace, outside]) { await exec('git', ['init', '-q'], { cwd }); await exec('git', ['config', 'user.name', 'Bridge Test'], { cwd }); await exec('git', ['config', 'user.email', 'bridge@example.invalid'], { cwd }); await writeFile(path.join(cwd, 'owned.txt'), 'baseline\n'); await exec('git', ['add', '.'], { cwd }); await exec('git', ['commit', '-qm', 'fixture'], { cwd }) }
  let bridge
  t.after(async () => { await bridge?.close(); await rm(root, { recursive: true, force: true }) })
  bridge = await createBridge({ config: { stateDir, workspaceRoots: [path.join(root, 'allowed')], maxParallel: 2 }, run })
  const descriptor = JSON.parse(await readFile(bridge.connectionPath, 'utf8'))
  const rpc = async (method, args = {}, headers = {}) => { const response = await fetch(`${descriptor.url}/rpc`, { method: 'POST', headers: { authorization: `Bearer ${descriptor.token}`, 'content-type': 'application/json', ...headers }, body: JSON.stringify({ method, args }) }); return { status: response.status, body: await response.json() } }
  const ticket = key => ({ idempotencyKey: key, task: 'Edit owned.txt', acceptance: 'Focused tests pass', workspace, ownedPaths: ['owned.txt'], timeoutMs: 5000, maxSteps: 2 })
  const finish = async id => { let state = (await rpc('deepseek_status', { id })).body.result; for (let count = 0; count < 10 && ['queued', 'running'].includes(state.status); count++) state = (await rpc('deepseek_wait', { id, afterRevision: state.revision, waitMs: 1000 })).body.result; assert.equal(state.status, 'awaiting_review'); return (await rpc('deepseek_status', { id })).body.result }
  return { bridge, descriptor, workspace, outside, rpc, ticket, finish }
}

test('descriptor binds loopback and protects token with 0600; health and errors never expose token', async t => {
  const f = await fixture(t)
  assert.match(f.descriptor.url, /^http:\/\/127\.0\.0\.1:\d+$/)
  assert.equal((await stat(f.bridge.connectionPath)).mode & 0o777, 0o600)
  assert.match(f.descriptor.token, /^[a-f0-9]{64}$/)
  const health = await f.rpc('deepseek_health')
  assert.equal(health.status, 200); assert.equal(health.body.result.ready, true)
  assert.equal(health.body.result.version, 1)
  assert.equal(health.body.result.bridgeVersion, '1.1.0')
  assert.deepEqual(health.body.result.capabilities, { budgetHandoff: true, continuation: true, maxContinuationDepth: 3 })
  assert.equal(health.body.result.model, 'deepseek-flash')
  assert.equal(health.body.result.approval, 'orchestrator_review_required')
  assert.equal(JSON.stringify(health.body).includes(f.descriptor.token), false)
  const error = await f.rpc('deepseek_status', { id: f.descriptor.token })
  assert.equal(error.status, 200); assert.match(error.body.error, /unknown job id/); assert.equal(JSON.stringify(error.body).includes(f.descriptor.token), false)
})
test('invalid authorization, browser origin and malformed protocol are refused', async t => {
  const f = await fixture(t)
  assert.equal((await f.rpc('deepseek_health', {}, { authorization: 'Bearer incorrect' })).status, 401)
  assert.equal((await f.rpc('deepseek_health', {}, { origin: 'http://evil.example.invalid' })).status, 400)
  assert.equal((await f.rpc('deepseek_health', {}, { 'content-type': 'text/plain' })).status, 400)
  assert.match((await f.rpc('unknown_method')).body.error, /Invalid method/)
  assert.match((await f.rpc('deepseek_health', [])).body.error, /Invalid method/)
  const response = await fetch(`${f.descriptor.url}/rpc`, { headers: { authorization: `Bearer ${f.descriptor.token}` } })
  assert.equal(response.status, 404)
})
test('workspace outside configured roots and a repository subdirectory are refused', async t => {
  const f = await fixture(t)
  const denied = await f.rpc('deepseek_submit', { ...f.ticket('outside'), workspace: f.outside })
  assert.equal(denied.status, 200); assert.match(denied.body.error, /outside configured/)
  await mkdir(path.join(f.workspace, 'nested'))
  const nested = await f.rpc('deepseek_submit', { ...f.ticket('nested'), workspace: path.join(f.workspace, 'nested') })
  assert.equal(nested.status, 200); assert.match(nested.body.error, /root of an existing Git worktree/)
  assert.equal((await f.rpc('deepseek_list')).body.result.length, 0)
})
test('submit, status, list, wait, approval and rejection share durable JobManager state', async t => {
  const f = await fixture(t)
  const submitted = await f.rpc('deepseek_submit', f.ticket('ticket-1')); assert.equal(submitted.status, 200)
  const id = submitted.body.result.id
  const state = await f.finish(id)
  assert.equal(state.result.sessionId, 'fake-session')
  assert.equal(state.result.evidence.validation, 'worker_report_requires_independent_review')
  assert.equal((await f.rpc('deepseek_list')).body.result[0].id, id)
  const approved = await f.rpc('deepseek_review', { id, decision: 'approve' })
  assert.equal(approved.body.result.status, 'approved')
  assert.match((await f.rpc('deepseek_review', { id, decision: 'approve' })).body.error, /only awaiting_review/)
  const duplicate = await f.rpc('deepseek_submit', f.ticket('ticket-1'))
  assert.equal(duplicate.body.result.id, id); assert.equal(duplicate.body.result.status, 'approved')
  const second = (await f.rpc('deepseek_submit', f.ticket('ticket-2'))).body.result
  await f.finish(second.id)
  assert.equal((await f.rpc('deepseek_review', { id: second.id, decision: 'reject', feedback: 'Contract failed' })).body.result.status, 'rejected')
})
test('approval is refused during execution; cancellation aborts and drains stub worker', async t => {
  const started = deferred(), drained = deferred()
  const f = await fixture(t, async (_, { signal }) => { started.resolve(); await new Promise(resolve => { signal.addEventListener('abort', resolve, { once: true }) }); drained.resolve(); throw new Error('cancelled') })
  const id = (await f.rpc('deepseek_submit', f.ticket('running'))).body.result.id
  await started.promise
  const rejected = await f.rpc('deepseek_review', { id, decision: 'approve' })
  assert.equal(rejected.status, 200); assert.match(rejected.body.error, /only awaiting_review/)
  const cancelled = await f.rpc('deepseek_cancel', { id })
  assert.equal(cancelled.body.result.status, 'cancelled'); await drained.promise
})
test('continuation dispatch reaches JobManager.continue for known jobs only', async t => {
  const f = await fixture(t)
  const refused = await f.rpc('deepseek_continue', { id: 'missing-job', idempotencyKey: 'continue-1', feedback: 'Checkpoint reviewed' })
  assert.equal(refused.status, 200)
  assert.equal(typeof refused.body.error, 'string')
  assert.doesNotMatch(refused.body.error, /Invalid method/)
  assert.equal(refused.body.result, undefined)
  const id = (await f.rpc('deepseek_submit', f.ticket('continue-parent'))).body.result.id
  await f.finish(id)
  const notExhausted = await f.rpc('deepseek_continue', { id, idempotencyKey: 'continue-2', feedback: 'Checkpoint reviewed' })
  assert.equal(notExhausted.status, 200)
  assert.equal(typeof notExhausted.body.error, 'string')
  assert.equal(notExhausted.body.result, undefined)
  const listed = (await f.rpc('deepseek_list')).body.result
  assert.deepEqual(listed.map(job => job.id), [id])
  assert.equal((await f.rpc('deepseek_status', { id })).body.result.status, 'awaiting_review')
})
test('close removes connection descriptor and prevents further authenticated requests', async t => {
  const f = await fixture(t)
  await f.bridge.close(); await f.bridge.close()
  await assert.rejects(stat(f.bridge.connectionPath), { code: 'ENOENT' })
  await assert.rejects(f.rpc('deepseek_health'))
})


test('HTTP continuation validates a saved checkpoint, deduplicates, and stays review-gated', async t => {
  let f, runs=0
  f=await fixture(t, async job=>{
    runs++
    if(job.continuation) {
      assert.equal(job.continuation.previousResult.summary,'Need one more focused check')
      return {summary:'Checked the preserved work',outcome:'completed'}
    }
    const current=await snapshot(job.workspace)
    const text=JSON.stringify({head:current.head,indexAfter:current.indexSha256,after:{sha256:createHash('sha256').update(current.patch).digest('hex')},filesAfter:current.files})
    const file=path.join(path.dirname(f.bridge.connectionPath),'checkpoint.json')
    await writeFile(file,text)
    return {summary:'Need one more focused check',outcome:'budget_exhausted',evidence:{evidenceFile:{path:file,bytes:Buffer.byteLength(text),sha256:createHash('sha256').update(text).digest('hex')}}}
  })
  let parent=(await f.rpc('deepseek_submit',f.ticket('handoff'))).body.result
  while(['queued','running'].includes(parent.status))parent=(await f.rpc('deepseek_wait',{id:parent.id,afterRevision:parent.revision,waitMs:1000})).body.result
  assert.equal(parent.status,'budget_exhausted'); assert.equal(parent.stopReason.code,'STEP_BUDGET_EXHAUSTED')
  assert.match((await f.rpc('deepseek_review',{id:parent.id,decision:'approve'})).body.error,/awaiting_review/)
  const args={id:parent.id,idempotencyKey:'continued',feedback:'Checkpoint inspected; finish the focused check',maxSteps:5}
  const [first,retry]=await Promise.all([f.rpc('deepseek_continue',args),f.rpc('deepseek_continue',args)])
  assert.equal(first.body.result.id,retry.body.result.id)
  assert.equal((await f.finish(first.body.result.id)).status,'awaiting_review')
  assert.equal((await f.rpc('deepseek_review',{id:first.body.result.id,decision:'approve',feedback:'Independently checked'})).body.result.status,'approved')
  assert.equal(runs,2)
  assert.equal((await f.rpc('deepseek_status',{id:parent.id})).body.result.status,'budget_exhausted')
})
