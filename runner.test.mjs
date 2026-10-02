import test from 'node:test'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, stat, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHarnessRunner, snapshot, validateContinuation } from './runner.js'

const exec = promisify(execFile)
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'bridge-runner-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = path.join(root, 'repo'), stateDir = path.join(root, 'state')
  await mkdir(workspace)
  const git = (...args) => exec('git', args, { cwd: workspace })
  await git('init', '-q'); await git('config', 'user.name', 'Bridge Test'); await git('config', 'user.email', 'bridge@example.invalid')
  await writeFile(path.join(workspace, 'owned.txt'), 'baseline\n'); await writeFile(path.join(workspace, 'other.txt'), 'untouched\n')
  await git('add', '.'); await git('commit', '-qm', 'fixture')
  return { workspace, stateDir, git, job: { id: 'fixture-job', workspace, task: 'Change owned.txt', acceptance: 'Keep other.txt intact', ownedPaths: ['owned.txt'], maxSteps: 2, revisions: 0 } }
}
function harness(scenario = async h => h.complete(), options = {}) {
  const observers = new Set(), facts = { disposed: 0, cancelled: [], followups: [], options: undefined, allow: undefined, permission: undefined }
  let phase = 'idle', idle, permission = 'workspace-write'
  const h = {
    facts,
    setPermission(value) { permission = value },
    emit(type, data = {}) { for (const observer of [...observers]) observer(h.session, { type, data }) },
    async step() { h.assembly = await h.assemble({ tools: [{ name: 'bash' }] }, { agent: h.agent }, async () => ({ tools: [{ name: 'bash' }], text: 'existing prompt' })); const answer = await h.preStep({ agent: h.agent, messages: [], turn: 1, step: ++h.proposed }, async () => ({ kind: 'enter', messages: [] })); h.decisions.push(answer); if (answer.kind === 'reject') { h.emit('turn/end', { turn: 1, reason: { kind: 'blocked' } }); return false } h.emit('step/start', { turn: 1, step: h.proposed }); return true },
    complete(text = 'Worker report') { h.emit('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text }] }, usage: { inputTokens: 10, outputTokens: 3 } }); h.emit('turn/end', { turn: 1, reason: { kind: 'completed' } }) },
    proposed: 0, decisions: [],
  }
  h.agent = { get status() { return phase }, followup(message) {
    assert.equal(message.role, 'user', 'followup requires a complete UserMessage, not a draft')
    assert.match(message.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    assert.ok(Object.isFrozen(message) && Object.isFrozen(message.source) && Object.isFrozen(message.content) && Object.isFrozen(message.content[0]))
    assert.equal(message.source.kind, 'user', 'DeepSeek format v4 must receive a supported producer source'); facts.followups.push(message); phase = 'running'; idle = Promise.resolve().then(() => scenario(h)).finally(() => { phase = 'idle' }) }, whenIdle: () => idle ?? Promise.resolve(), cancel(cause) { facts.cancelled.push(cause); options.onCancel?.(h) } }
  h.ctx = { get(name) { assert.equal(name, 'agentPresets'); return { async resolve(id) { assert.equal(id, 'standard'); return { id } }, async mount(agentCtx, id) { assert.equal(id, 'standard'); facts.mounted = agentCtx } } }, permissionPresets: { resolve() { return options.permissionSpec ?? { sandbox: 'workspace-write', approval: 'ask' } }, current() { return permission }, set(session, preset) { assert.equal(session, h.session); facts.permission = preset; permission = preset } }, on(name, callback) { assert.equal(name, 'session/event'); observers.add(callback); return () => observers.delete(callback) }, agents: { async create(createOptions) { facts.options = createOptions; h.session = { id: createOptions.sessionId, header: { cwd: createOptions.meta.cwd } }; h.agent.session = h.session
    await createOptions.setup({ get permissionPresets() { throw new Error('cannot get property permissionPresets without inject') }, get tools() { throw new Error('cannot get property tools without inject') }, get(name) { assert.equal(name, 'tools'); return { restrict({ allow }) { assert.ok(facts.mounted, 'preset must mount before tool restriction'); facts.allow = allow }, presentAs(mode) { facts.mode = mode }, guard(callback) { h.guard = callback } } }, on(name, callback, hookOptions) { assert.ok(['agent/pre-step', 'system-prompt/assemble'].includes(name)); assert.equal(hookOptions.prepend, true); if (name === 'agent/pre-step') h.preStep = callback; else h.assemble = callback } }, h.agent)
    // Real factory publishes after setup; fresh-session default pinning happens here.
    permission = options.creationPermission ?? permission
    await options.beforeCreateReturn?.(h)
    return { agent: h.agent, async dispose() { facts.disposed++; options.onDispose?.(h); await h.agent.whenIdle() } }
  } } }
  h.observers = observers
  return h
}
async function run(f, h, controller = new AbortController()) {
  const progress = []
  const result = await createHarnessRunner(h.ctx, { stateDir: f.stateDir })(f.job, { signal: controller.signal, onProgress: async value => { progress.push(value) } })
  return { result, progress }
}

test('completed worker produces independently reviewable Git evidence and drains resources', async t => {
  const f = await fixture(t), h = harness(async h => { await h.step(); await writeFile(path.join(f.workspace, 'owned.txt'), 'changed\n'); h.emit('tool/call'); h.emit('tool/result', { message: { isError: true } }); h.complete('Test command failed; inspect independently') })
  const { result, progress } = await run(f, h)
  assert.equal(result.summary, 'Test command failed; inspect independently')
  assert.deepEqual(result.evidence.changedPaths, ['owned.txt'])
  assert.equal(result.evidence.toolCalls, 1); assert.equal(result.evidence.toolErrors, 1)
  assert.equal(result.evidence.validation, 'worker_report_requires_independent_review')
  assert.equal(result.evidence.head, (await f.git('rev-parse', 'HEAD')).stdout.trim())
  assert.match(await readFile(path.join(result.evidence.artifactDir, 'after.patch'), 'utf8'), /\+changed/)
  assert.equal((await stat(path.join(result.evidence.artifactDir, 'evidence.json'))).mode & 0o777, 0o600)
  assert.equal(progress.at(-1).steps, 1); assert.equal(progress.at(-1).remainingSteps, 1); assert.equal(progress.at(-1).toolCalls, 1); assert.equal(progress.at(-1).toolErrors, 1); assert.equal(h.facts.disposed, 1); assert.equal(h.observers.size, 0)
})
for (const reason of [undefined, 'blocked', 'max-tokens', 'aborted', 'error']) test(`assistant text cannot establish completion: ${reason ?? 'missing terminal'}`, async t => {
  const f = await fixture(t), h = harness(h => { h.emit('assistant/message', { message: { content: [{ type: 'text', text: 'Success!' }] } }); if (reason) h.emit('turn/end', { reason: { kind: reason } }) })
  await assert.rejects(run(f, h), /Worker did not complete/)
  assert.equal(h.facts.disposed, 1); assert.equal(h.observers.size, 0)
})
test('step budget rejects the next model step before its execution', async t => {
  const f = await fixture(t); f.job.maxSteps = 1
  const h = harness(async h => { assert.equal(await h.step(), true); assert.equal(await h.step(), false) })
  const { result } = await run(f, h)
  assert.equal(result.outcome, 'budget_exhausted'); assert.match(result.summary, /Step budget exhausted/); assert.equal(result.evidence.terminal, 'blocked')
  assert.equal(h.proposed, 2); assert.equal(h.facts.disposed, 1)
})
test('pre-existing staged, unstaged and untracked content remains intact and outside incremental ownership', async t => {
  const f = await fixture(t)
  await writeFile(path.join(f.workspace, 'other.txt'), 'staged contributor edit\n'); await f.git('add', 'other.txt')
  await writeFile(path.join(f.workspace, 'other.txt'), 'unstaged contributor edit\n'); await writeFile(path.join(f.workspace, 'untracked.txt'), 'contributor new file\n')
  const before = await snapshot(f.workspace)
  const h = harness(async h => { await writeFile(path.join(f.workspace, 'owned.txt'), 'worker change\n'); h.complete() })
  const { result } = await run(f, h)
  assert.deepEqual(result.evidence.changedPaths, ['owned.txt'])
  const fullEvidence = JSON.parse(await readFile(path.join(result.evidence.artifactDir, 'evidence.json'), 'utf8'))
  assert.equal(fullEvidence.filesAfter['other.txt'], before.files['other.txt'])
  assert.equal(fullEvidence.filesAfter['untracked.txt'], before.files['untracked.txt'])
  assert.equal((await f.git('show', ':other.txt')).stdout, 'staged contributor edit\n')
})
test('unowned edits refuse review evidence without reverting worker or contributor files', async t => {
  const f = await fixture(t), h = harness(async h => { await writeFile(path.join(f.workspace, 'other.txt'), 'out of scope\n'); h.complete() })
  await assert.rejects(run(f, h), /outside ownership: other.txt/)
  assert.equal(await readFile(path.join(f.workspace, 'other.txt'), 'utf8'), 'out of scope\n')
})
test('a worker changing HEAD cannot be reported as completed', async t => {
  const f = await fixture(t), h = harness(async h => { await f.git('commit', '--allow-empty', '-qm', 'forbidden'); h.complete() })
  await assert.rejects(run(f, h), /changed Git HEAD/)
})
test('worker scope pins sandbox, bounds model output and hides delegation/plugin tools', async t => {
  const f = await fixture(t), h = harness(); await run(f, h)
  assert.equal(h.facts.permission, 'workspace-write')
  assert.deepEqual(h.facts.allow, ['read', 'read_image', 'write', 'edit', 'glob', 'grep', 'bash', 'job_output', 'job_list', 'job_kill'])
  assert.equal(h.facts.mode, 'native'); assert.equal(h.facts.options.meta.agentPreset, 'standard')
  for (const name of ['subagent', 'plugin_manager', 'verify_test_run', 'unrecognized_tool']) assert.match(h.guard({ name, arguments: {} }), /unavailable/)
  for (const name of ['read', 'write', 'edit']) assert.equal(h.guard({ name, arguments: { file_path: path.join(f.workspace, 'owned.txt') } }), undefined)
  assert.match(h.guard({ name: 'run_code', arguments: {} }), /unavailable/)
  assert.equal(h.facts.options.agentOptions.provider, 'deepseek-account'); assert.equal(h.facts.options.agentOptions.model, 'deepseek-flash'); assert.equal(h.facts.options.agentOptions.maxTokens, 8192)
  assert.match(h.guard({ name: 'bash', arguments: { run_in_background: true } }), /Background jobs/)
  assert.equal(h.guard({ name: 'bash', arguments: { command: 'npm test' } }), undefined)
  assert.equal(h.facts.options.meta.cwd, f.workspace)
})
test('abort arriving during creation prevents prompt admission and disposes returned handle', async t => {
  const f = await fixture(t), controller = new AbortController()
  const h = harness(undefined, { beforeCreateReturn() { controller.abort() } })
  await assert.rejects(run(f, h, controller), error => /aborted/i.test(error.message) && Boolean(error.result?.evidence))
  assert.equal(h.facts.followups.length, 0); assert.equal(h.facts.disposed, 1); assert.equal(h.observers.size, 0)
})
test('abort during execution cancels worker, waits for quiescence and disposes before returning', async t => {
  const f = await fixture(t), controller = new AbortController(), started = deferred(), drained = deferred()
  const h = harness(async h => { started.resolve(); await drained.promise; h.emit('turn/end', { reason: { kind: 'aborted' } }) }, { onCancel() { drained.resolve() } })
  const running = run(f, h, controller); await started.promise; controller.abort()
  await assert.rejects(running, error => /aborted/i.test(error.message) && Boolean(error.result?.evidence))
  assert.deepEqual(h.facts.cancelled, [{ kind: 'user' }]); assert.equal(h.facts.disposed, 1); assert.equal(h.agent.status, 'idle')
})
test('usage includes retried attempts from the real compact stream and never double-counts successful usage', async t => {
  const f = await fixture(t), h = harness(h => {
    h.emit('assistant/attempt', { stream: [{ type: 'chunk', time: 1, chunk: { type: 'usage', usage: { inputTokens: 20, outputTokens: 7, cacheReadTokens: 5 } } }] })
    h.emit('assistant/message', { message: { content: [{ type: 'text', text: 'Done' }] }, usage: { inputTokens: 10, outputTokens: 3, cacheWriteTokens: 2 }, stream: [{ type: 'chunk', time: 2, chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 3, cacheWriteTokens: 2 } } }] })
    h.emit('turn/end', { reason: { kind: 'completed' } })
  })
  const { result } = await run(f, h)
  assert.deepEqual(result.usage, { inputTokens: 30, outputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 2, reportedAttempts: 2, missingAttempts: 0, complete: true })
})
test('missing provider usage is explicitly incomplete', async t => {
  const f = await fixture(t), h = harness(h => { h.emit('assistant/attempt', { stream: [] }); h.complete() })
  const { result } = await run(f, h)
  assert.equal(result.usage.complete, false); assert.equal(result.usage.missingAttempts, 1)
})
test('provider refusal retains actionable code and message without claiming model success', async t => {
  const f = await fixture(t), h = harness(h => h.emit('turn/end', { reason: { kind: 'error', error: { code: 'TRANSPORT', message: 'DeepSeek Messages transport failed' } } }))
  await assert.rejects(run(f, h), error => {
    assert.match(error.message, /TRANSPORT: DeepSeek Messages transport failed/)
    assert.deepEqual(error.result.evidence.providerError, { code: 'TRANSPORT', message: 'DeepSeek Messages transport failed' })
    assert.equal(error.result.usage.complete, false)
    return true
  })
})

test('failed worker retains final Git evidence and usage for orchestrator review', async t => {
  const f = await fixture(t), h = harness(async h => {
    await writeFile(path.join(f.workspace, 'owned.txt'), 'partial worker change\n')
    h.emit('assistant/message', { message: { content: [{ type: 'text', text: 'Validation failed' }] }, usage: { inputTokens: 12, outputTokens: 4 } })
    h.emit('turn/end', { reason: { kind: 'error' } })
  })
  let failure
  await assert.rejects(run(f, h), error => {
    failure = error
    assert.match(error.message, /Worker did not complete: error/)
    assert.deepEqual(error.result.evidence.changedPaths, ['owned.txt'])
    assert.equal(error.result.usage.outputTokens, 4)
    assert.equal(error.result.evidence.terminal, 'error')
    assert.equal(error.result.outcome, undefined)
    return true
  })
  assert.match(await readFile(path.join(failure.result.evidence.artifactDir, 'after.patch'), 'utf8'), /partial worker change/)
})
test('unowned index-only mutation is rejected even when worktree bytes stay identical', async t => {
  const f = await fixture(t)
  await writeFile(path.join(f.workspace, 'other.txt'), 'contributor edit\n')
  const h = harness(async h => { await f.git('add', 'other.txt'); h.complete() })
  await assert.rejects(run(f, h), error => {
    assert.match(error.message, /outside ownership: other.txt/)
    assert.deepEqual(error.result.evidence.changedIndexPaths, ['other.txt'])
    return true
  })
})

test('large existing dirty checkout keeps complete evidence on disk and bounded review payload', async t => {
  const f = await fixture(t)
  const names = Array.from({ length: 300 }, (_, index) => `contributor-${String(index).padStart(4, '0')}-${'x'.repeat(140)}.txt`)
  await Promise.all(names.map(name => writeFile(path.join(f.workspace, name), 'pre-existing contributor content\n')))
  const h = harness(async h => { await writeFile(path.join(f.workspace, 'owned.txt'), 'worker change\n'); h.complete() })
  const { result } = await run(f, h)
  assert.ok(Buffer.byteLength(JSON.stringify(result.evidence)) < 32_000)
  assert.equal(Object.hasOwn(result.evidence, 'filesBefore'), false)
  assert.equal(Object.hasOwn(result.evidence, 'filesAfter'), false)
  assert.deepEqual(result.evidence.changedPaths, ['owned.txt'])
  const fullBytes = await readFile(result.evidence.evidenceFile.path)
  assert.equal(result.evidence.evidenceFile.bytes, fullBytes.length)
  assert.equal(result.evidence.evidenceFile.sha256, createHash('sha256').update(fullBytes).digest('hex'))
  const full = JSON.parse(fullBytes)
  assert.equal(Object.keys(full.filesBefore).length, names.length)
  assert.equal(full.filesBefore[names[0]], full.filesAfter[names[0]])
  assert.ok(fullBytes.length > 32_000)
})


test('budget warning precedes a tool-free final handoff within the original hard cap', async t => {
  const f = await fixture(t); f.job.maxSteps = 4
  const h = harness(async h => {
    assert.equal(await h.step(), true)
    assert.equal(h.decisions.at(-1).messages.length, 0)
    assert.equal(await h.step(), true)
    const warning = h.decisions.at(-1).messages.at(-1)
    assert.equal(warning.role, 'user'); assert.ok(warning.id); assert.match(warning.content[0].text, /3 model steps remain/)
    assert.equal(await h.step(), true)
    assert.equal(h.decisions.at(-1).messages.length, 0, 'warning must not be repeated every step')
    await writeFile(path.join(f.workspace, 'owned.txt'), 'checkpoint work\n')
    assert.equal(await h.step(), true)
    assert.deepEqual(h.assembly.tools, [])
    assert.match(h.guard({name:'edit'}), /handoff/)
    assert.match(h.guard({name:'bash'}), /handoff/)
    assert.match(h.decisions.at(-1).messages.at(-1).content[0].text, /final reserved model step/)
    h.complete('Step budget handoff — changes saved; validation still needed.')
  })
  const { result, progress } = await run(f,h)
  assert.equal(result.outcome, 'budget_exhausted')
  assert.equal(result.evidence.steps, 4)
  assert.equal(result.evidence.budget.summaryStepUsed, true)
  assert.deepEqual(result.evidence.changedPaths, ['owned.txt'])
  assert.equal(progress.at(-1).phase, 'handoff'); assert.equal(progress.at(-1).remainingSteps, 0)
  assert.equal(h.proposed, 4, 'the summary must not secretly add a model call')
})

test('early completion remains reviewable and final-step tool attempts cannot execute', async t => {
  const f = await fixture(t); f.job.maxSteps = 3
  const early = harness(async h => { await h.step(); h.complete() })
  assert.equal((await run(f, early)).result.outcome, 'completed')
  const h = harness(async h => {
    await h.step(); await h.step(); await h.step()
    assert.deepEqual(h.assembly.tools, [])
    assert.match(h.guard({name:'write'}), /tools are disabled/)
    assert.equal(await h.step(), false)
  })
  const {result} = await run(f,h)
  assert.equal(result.outcome, 'budget_exhausted'); assert.equal(result.evidence.steps, 3)
  assert.match(result.summary, /No final worker summary/)
})

test('scope violation takes precedence over a budget handoff', async t => {
  const f = await fixture(t); f.job.maxSteps = 3
  const h = harness(async h => {await h.step(); await writeFile(path.join(f.workspace,'other.txt'),'unowned\n'); await h.step(); await h.step(); h.complete('Handoff')})
  await assert.rejects(run(f,h), error => error.code === 'WORKSPACE_SCOPE_VIOLATION' && Boolean(error.result.evidence) && error.result.outcome === undefined)
})

async function checkpoint(t) {
  const f=await fixture(t); f.job.maxSteps=1
  const h=harness(async h=>{await h.step(); await writeFile(path.join(f.workspace,'owned.txt'),'preserved partial edit\n'); await h.step()})
  const {result}=await run(f,h)
  return {f,result,parent:{workspace:f.workspace,result}}
}

test('continuation validates pinned evidence and preserves prior work/context in a fresh worker', async t => {
  const {f,result,parent}=await checkpoint(t)
  await validateContinuation(parent,{stateDir:f.stateDir})
  const h=harness(async h=>{assert.equal(await readFile(path.join(f.workspace,'owned.txt'),'utf8'),'preserved partial edit\n'); await h.step(); h.complete('Finished independent verification')})
  f.job={...f.job,id:'continued-job',maxSteps:5,continuation:{parentJobId:'parent-job',depth:1,feedback:'Run the missing focused test',previousResult:result}}
  const {result:continued}=await run(f,h)
  const text=h.facts.followups[0].content[0].text
  assert.match(text,/Continue the preserved work from job parent-job/)
  assert.match(text,/Run the missing focused test/)
  assert.match(text,/Step budget exhausted/)
  assert.notEqual(continued.sessionId,result.sessionId)
  assert.equal(continued.outcome,'completed')
})

for(const change of ['worktree','index','HEAD','untracked','evidence']) test(`continuation refuses changed ${change} before another model request`, async t=>{
  const {f,result,parent}=await checkpoint(t)
  if(change==='worktree') await writeFile(path.join(f.workspace,'owned.txt'),'another contributor edit\n')
  if(change==='index') await f.git('add','owned.txt')
  if(change==='HEAD') await f.git('commit','--allow-empty','-qm','new head')
  if(change==='untracked') await writeFile(path.join(f.workspace,'new.txt'),'external work\n')
  if(change==='evidence') await writeFile(result.evidence.evidenceFile.path,'{}')
  await assert.rejects(validateContinuation(parent,{stateDir:f.stateDir}),error=>/^CHECKPOINT_/.test(error.code))
  const h=harness(); f.job={...f.job,continuation:{parentJobId:'parent',depth:1,feedback:'Continue',previousResult:result}}
  await assert.rejects(run(f,h),error=>/^CHECKPOINT_/.test(error.code))
  assert.equal(h.facts.followups.length,0); assert.equal(h.facts.options,undefined)
})


test('continuation refuses a workspace removed from the current allowlist', async t => {
  const {f,parent}=await checkpoint(t)
  await assert.rejects(validateContinuation(parent,{stateDir:f.stateDir,workspaceRoots:[f.stateDir]}), error=>error.code==='CHECKPOINT_WORKSPACE_REFUSED')
})

test('review revision of a continuation preserves child edits without reusing the parent checkpoint', async t => {
  const {f,result}=await checkpoint(t)
  f.job={...f.job,id:'continued-job',maxSteps:5,feedback:'Original direction',continuation:{parentJobId:'parent-job',depth:1,feedback:'Original direction',previousResult:result}}
  const first=harness(async h=>{await h.step(); await writeFile(path.join(f.workspace,'owned.txt'),'child implementation\n'); h.complete('Ready for review')})
  await run(f,first)
  assert.equal(first.facts.followups[0].content[0].text.split('Original direction').length,2)
  f.job={...f.job,revisions:1,feedback:'Verify child implementation and correct its report'}
  const revision=harness(async h=>{assert.equal(await readFile(path.join(f.workspace,'owned.txt'),'utf8'),'child implementation\n'); await h.step(); h.complete('Review correction verified')})
  const revised=await run(f,revision)
  assert.equal(revised.result.outcome,'completed')
  assert.match(revision.facts.followups[0].content[0].text,/Verify child implementation and correct its report/)
  assert.doesNotMatch(revision.facts.followups[0].content[0].text,/checkout was verified against its saved checkpoint/)
})


test('creation defaults cannot replace the worker sandbox before its first model call', async t => {
  const f = await fixture(t)
  const h = harness(h => { assert.equal(h.ctx.permissionPresets.current(h.session), 'workspace-write'); h.complete() }, { creationPermission: 'danger-full-access' })
  await run(f, h)
})
test('misconfigured workspace preset refuses before submitting any model work', async t => {
  const f = await fixture(t), h = harness(undefined, { permissionSpec: { sandbox: 'danger-full-access', approval: 'never' } })
  await assert.rejects(run(f, h), /workspace-write.*ask/)
  assert.equal(h.facts.followups.length, 0)
  assert.equal(h.facts.disposed, 1)
})
test('permission drift and per-call escalation cannot dispatch worker tools', async t => {
  const f = await fixture(t), h = harness(); await run(f, h)
  assert.match(h.guard({ name: 'bash', arguments: { command: 'true', sandbox_permissions: 'danger-full-access' } }), /escalation/)
  h.setPermission('danger-full-access')
  assert.match(h.guard({ name: 'edit', arguments: { file_path: path.join(f.workspace, 'owned.txt') } }), /permission/)
  assert.equal(await h.step(), false, 'drift must stop the next model step')
})
test('file and search tools refuse another checkout, traversal, and symlink escape', async t => {
  const f = await fixture(t), h = harness(); await run(f, h)
  const other = path.join(path.dirname(f.workspace), 'other-checkout'); await mkdir(other)
  await writeFile(path.join(other, 'owned.txt'), 'outside sentinel')
  await symlink(other, path.join(f.workspace, 'escape'))
  for (const target of [path.join(other, 'owned.txt'), '../other-checkout/owned.txt', 'escape/owned.txt', 'escape/new.txt']) {
    for (const name of ['read', 'read_image', 'write', 'edit']) assert.match(h.guard({ name, arguments: { file_path: target } }), /checkout/)
    for (const name of ['glob', 'grep']) assert.match(h.guard({ name, arguments: { path: target } }), /checkout/)
    assert.match(h.guard({ name: 'bash', arguments: { workdir: path.dirname(target), command: 'true' } }), /checkout/)
  }
  for (const name of ['write', 'edit']) assert.match(h.guard({ name, arguments: { file_path: 'other.txt' } }), /owned/)
  assert.equal(h.guard({ name: 'read', arguments: { file_path: 'other.txt' } }), undefined)
  assert.equal(h.guard({ name: 'write', arguments: { file_path: 'owned.txt' } }), undefined)
  assert.equal(h.guard({ name: 'grep', arguments: { pattern: 'test' } }), undefined)
  assert.equal(await readFile(path.join(other, 'owned.txt'), 'utf8'), 'outside sentinel')
})

test('symlink followed by parent traversal cannot borrow ownership of a different file', async t => {
  const f = await fixture(t), h = harness(); await run(f, h)
  await mkdir(path.join(f.workspace, 'nested/deep'), { recursive: true })
  await writeFile(path.join(f.workspace, 'nested/owned.txt'), 'unowned sentinel')
  await symlink(path.join(f.workspace, 'nested/deep'), path.join(f.workspace, 'link'))
  for (const name of ['read', 'write', 'edit']) assert.match(h.guard({ name, arguments: { file_path: 'link/../owned.txt' } }), /Parent traversal/)
  assert.equal(await readFile(path.join(f.workspace, 'nested/owned.txt'), 'utf8'), 'unowned sentinel')
})
