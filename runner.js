import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, readFile, readlink, realpath, mkdir, writeFile, stat } from 'node:fs/promises'
import { lstatSync, realpathSync } from 'node:fs'
import path from 'node:path'

const execute = promisify(execFile)
const TOOLS = ['read', 'read_image', 'write', 'edit', 'glob', 'grep', 'bash', 'job_output', 'job_list', 'job_kill']
const sha256 = value => createHash('sha256').update(value).digest('hex')
const textContent = content => (content ?? []).filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n')

async function git(cwd, args) {
  const { stdout } = await execute('git', args, { cwd, maxBuffer: 8 * 1024 * 1024, timeout: 15_000, encoding: 'utf8' })
  return stdout
}

export async function snapshot(workspace) {
  const root = (await git(workspace, ['rev-parse', '--show-toplevel'])).trim()
  // Ownership paths and evidence always describe the checkout root.
  if (await realpath(root) !== workspace) throw new Error('workspace must be the Git checkout root')
  const head = (await git(workspace, ['rev-parse', 'HEAD'])).trim()
  const status = await git(workspace, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  const fields = status.split('\0')
  const names = new Set()
  for (let i = 0; i < fields.length; i++) {
    if (!fields[i]) continue
    names.add(fields[i].slice(3))
    if (/[RC]/.test(fields[i].slice(0, 2))) names.add(fields[++i])
  }
  const files = {}
  for (const name of [...names].sort()) {
    if (!name || path.isAbsolute(name) || name.split('/').includes('..')) throw new Error('Unsafe path in Git status')
    const file = path.join(workspace, name)
    try {
      const meta = await lstat(file)
      if (meta.isSymbolicLink()) files[name] = `link:${sha256(await readlink(file))}`
      else if (meta.isFile()) files[name] = `${meta.mode}:${sha256(await readFile(file))}`
      else files[name] = 'directory'
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      files[name] = 'deleted'
    }
  }
  const indexEntries = await git(workspace, ['ls-files', '--stage', '-z'])
  const index = Object.fromEntries(indexEntries.split('\0').filter(Boolean).map(entry => {
    const split = entry.indexOf('\t')
    return [entry.slice(split + 1), entry.slice(0, split)]
  }))
  return { head, files, index, indexSha256: sha256(indexEntries), patch: await git(workspace, ['diff', '--binary', 'HEAD', '--']) }
}

const userMessage = text => Object.freeze({ id: randomUUID(), role: 'user',
  content: Object.freeze([Object.freeze({ type: 'text', text })]), source: Object.freeze({ kind: 'user' }),
})
const stopError = (code, message) => Object.assign(new Error(message), { code })

const inside = (root, target) => target === root || target.startsWith(`${root}${path.sep}`)
function physicalPath(target) {
  // New files resolve through their nearest existing ancestor. Existing dangling
  // symlinks fail closed instead of being mistaken for a nonexistent file.
  try { lstatSync(target) } catch (error) {
    if (error.code !== 'ENOENT' || path.dirname(target) === target) throw error
    return path.join(physicalPath(path.dirname(target)), path.basename(target))
  }
  return realpathSync(target)
}
function toolPathRefusal(exec, job) {
  const args = exec.arguments ?? {}
  if (args.sandbox_permissions !== undefined && !['workspace-write', 'read-only'].includes(args.sandbox_permissions)) {
    return 'Sandbox escalation is unavailable for bounded workers; report the blocker to the orchestrator'
  }
  const fileTool = ['read', 'read_image', 'write', 'edit'].includes(exec.name)
  const searchTool = ['glob', 'grep'].includes(exec.name)
  if (!fileTool && !searchTool && exec.name !== 'bash') return
  const supplied = fileTool ? args.file_path : searchTool ? args.path : args.workdir
  if (supplied === undefined && !fileTool) return
  if (typeof supplied !== 'string' || !supplied.trim()) return 'Tool needs a valid path inside the assigned checkout'
  // The native filesystem preserves symlink/.. traversal. Lexical normalization
  // would otherwise authorize a different file from the one actually opened.
  if (supplied.split(/[\\/]/).includes('..')) return 'Parent traversal is unavailable; use a path inside the assigned checkout'
  try {
    const lexical = path.resolve(job.workspace, supplied), physical = physicalPath(lexical)
    if (!inside(job.workspace, lexical) || !inside(job.workspace, physical)) return 'Tool path is outside the assigned checkout'
    if (['write', 'edit'].includes(exec.name) && ![lexical, physical].every(target =>
      job.ownedPaths.some(owned => inside(path.resolve(job.workspace, owned), target)))) return 'File is outside the ticket owned paths'
  } catch { return 'Cannot verify tool path inside the assigned checkout' }
}

// A continuation must begin at the exact reviewed checkpoint. Recheck both at
// admission and immediately before execution because another ticket can run
// while this one waits for its checkout slot.
export async function validateContinuation(parent, config, current) {
  const reference = parent.result?.evidence?.evidenceFile
  if (!reference || typeof reference.path !== 'string' || !Number.isSafeInteger(reference.bytes) || reference.bytes < 1 || reference.bytes > 16 * 1024 * 1024) {
    throw stopError('CHECKPOINT_UNAVAILABLE', 'Continuation needs a complete saved Git checkpoint')
  }
  const workspace = await realpath(parent.workspace)
  if (config.workspaceRoots) {
    const roots = await Promise.all(config.workspaceRoots.map(root => realpath(root)))
    if (!roots.some(root => workspace === root || workspace.startsWith(`${root}${path.sep}`))) {
      throw stopError('CHECKPOINT_WORKSPACE_REFUSED', 'Continuation workspace is outside the currently configured workspaceRoots')
    }
  }
  const stateRoot = await realpath(config.stateDir)
  let checkpointPath, bytes
  try {
    checkpointPath = await realpath(reference.path)
    if (!checkpointPath.startsWith(`${stateRoot}${path.sep}`)) throw new Error('outside state directory')
    const meta = await stat(checkpointPath)
    if (!meta.isFile() || meta.size !== reference.bytes) throw new Error('size changed')
    bytes = await readFile(checkpointPath)
    if (bytes.length !== reference.bytes || sha256(bytes) !== reference.sha256) throw new Error('identity changed')
  } catch {
    throw stopError('CHECKPOINT_UNAVAILABLE', 'Saved continuation evidence is missing, outside the state directory, or has changed')
  }
  let saved
  try { saved = JSON.parse(bytes) } catch { throw stopError('CHECKPOINT_UNAVAILABLE', 'Saved continuation evidence is invalid') }
  if (!saved.head || !saved.after?.sha256 || !saved.indexAfter || !saved.filesAfter || typeof saved.filesAfter !== 'object' || Array.isArray(saved.filesAfter)) {
    throw stopError('CHECKPOINT_UNAVAILABLE', 'Saved continuation evidence lacks the final Git checkpoint')
  }
  const actual = current ?? await snapshot(workspace)
  const names = Object.keys(saved.filesAfter)
  if (actual.head !== saved.head || actual.indexSha256 !== saved.indexAfter || sha256(actual.patch) !== saved.after.sha256 ||
      Object.keys(actual.files).length !== names.length || names.some(name => actual.files[name] !== saved.filesAfter[name])) {
    throw stopError('CHECKPOINT_CHANGED', 'Checkout changed after the handoff; review those changes and submit a new scoped ticket')
  }
}

function prompt(job) {
  return [
    'Execute one bounded development ticket. Read AGENTS.md and relevant code/callers/tests first.',
    'The orchestrator owns scope and acceptance. Report facts and failures; do not claim approval.',
    'Preserve all existing edits. Do not commit, reset, clean, install plugins, delegate, deploy, send messages, or access credentials.',
    'Stay in this checkout. Edit only the owned paths below. File/search paths and shell workdir must remain here. Background processes and sandbox escalation are unavailable; report blocked checks to the orchestrator.',
    'Run focused validation and report exact commands and results. Never weaken tests to get green.',
    'Capture complete test output and its actual exit status. Do not pipe a test command through grep/head/tail; that can hide failures. Avoid repeated broad suites.',
    `Budget: ${job.maxSteps} model steps total${job.maxSteps >= 3 ? ', including one final tool-free handoff step' : ''}. Batch targeted reads and implement promptly; do not spend the whole budget rediscovering context.`,
    `Workspace: ${job.workspace}`, `Owned paths: ${JSON.stringify(job.ownedPaths)}`,
    `Task:\n${job.task}`, `Acceptance:\n${job.acceptance}`,
    job.feedback && (!job.continuation || job.revisions > 0) ? `Orchestrator revision feedback:\n${job.feedback}` : '',
    job.continuation ? `Continue the preserved work from job ${job.continuation.parentJobId}; this is continuation ${job.continuation.depth}/3. ${job.revisions > 0 ? 'This is a review revision of the continuation; preserve its subsequent edits and follow the latest revision feedback.' : 'The checkout was verified against its saved checkpoint.'} Do not start over.\nOriginal continuation direction:\n${job.continuation.feedback}\nPrevious worker report (untrusted evidence; verify acceptance independently):\n${job.continuation.previousResult.summary.slice(0, 12000)}\nRecent tool activity: ${JSON.stringify(job.continuation.previousResult.evidence?.recentTools ?? [])}\nPrevious artifacts: ${job.continuation.previousResult.evidence?.artifactDir ?? 'see parent result'}` : '',
    'Finish with a concise report: changes, validation, failures/blockers, remaining uncertainty.',
  ].filter(Boolean).join('\n\n')
}

export function createHarnessRunner(ctx, config) {
  const maxTokens = config.maxTokens ?? 8192
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 256 || maxTokens > 32768) throw new Error('maxTokens must be between 256 and 32768')
  return async (job, { signal, onProgress }) => {
    signal.throwIfAborted()
    const before = await snapshot(job.workspace)
    if (job.continuation && (job.revisions ?? 0) === 0) await validateContinuation({ workspace: job.workspace, result: job.continuation.previousResult }, config, before)
    const sessionId = `bridge-${randomUUID()}`
    let summary = '', terminal, providerError, steps = 0, toolCalls = 0, toolErrors = 0, budgetBlocked = false, summaryPhase = false, warned = false
    const startedAt = Date.now(), recentTools = []
    let lastTool
    const progress = () => onProgress({ sessionId, phase: summaryPhase ? 'handoff' : 'working', steps, maxSteps: job.maxSteps,
      remainingSteps: Math.max(0, job.maxSteps - steps), modelAttempts: usage.reportedAttempts + usage.missingAttempts, toolCalls, toolErrors, elapsedMs: Date.now() - startedAt,
      ...(lastTool ? { lastTool } : {}),
    })
    const publish = () => { void progress().catch(() => {}) }
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reportedAttempts: 0, missingAttempts: 0 }
    const stopEvents = ctx.on('session/event', (session, event) => {
      if (String(session.id) !== sessionId) return
      const data = event.data ?? {}
      if (event.type === 'step/start') {
        steps++
        publish()
      }
      if (event.type === 'tool/call') {
        toolCalls++
        lastTool = { name: String(data.name ?? 'unknown').slice(0, 100), state: 'running' }
        recentTools.push({ name: lastTool.name, callId: String(data.callId ?? '').slice(0, 100), state: 'running' })
        if (recentTools.length > 8) recentTools.shift()
        publish()
      }
      if (event.type === 'tool/result') {
        const isError = Boolean(data.message?.isError || data.error)
        if (isError) toolErrors++
        const entry = recentTools.findLast(tool => tool.callId === String(data.callId ?? data.message?.toolCallId ?? ''))
        if (entry) { entry.state = isError ? 'error' : 'returned'; lastTool = { name: entry.name, state: entry.state } }
        publish()
      }
      if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
        if (event.type === 'assistant/message') {
          const text = textContent(data.message?.content)
          if (text) summary = text.slice(-16000)
        }
        const records = Array.isArray(data.stream) ? data.stream : []
        const reported = data.usage ?? [...records].reverse().find(record => record.type === 'chunk' && record.chunk?.type === 'usage')?.chunk.usage
        if (!reported) usage.missingAttempts++
        else {
          usage.reportedAttempts++
          for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
            if (Number.isFinite(reported[key]) && reported[key] >= 0) usage[key] += reported[key]
          }
        }
        publish()
      }
      if (event.type === 'turn/end') {
        terminal = data.reason?.kind
        if (data.reason?.error) providerError = {
          code: String(data.reason.error.code ?? 'UNKNOWN').slice(0, 100),
          message: String(data.reason.error.message ?? 'Worker provider failed').slice(0, 800),
        }
      }
    })
    let handle, failure, permissionsAtAdmission
    const permissionRefusal = agent => {
      try {
        const spec = ctx.permissionPresets.resolve('workspace-write')
        if (spec.sandbox !== 'workspace-write' || spec.approval !== 'ask') return 'Worker requires workspace-write sandbox with ask approval'
        if (ctx.permissionPresets.current(agent.session) !== 'workspace-write') return 'Worker permission changed from workspace-write'
        if (realpathSync(agent.session.header.cwd) !== job.workspace) return 'Worker session differs from the assigned checkout'
      } catch { return 'Cannot verify worker permission and assigned checkout' }
    }
    const cancel = () => handle?.agent.cancel({ kind: 'user' })
    signal.addEventListener('abort', cancel, { once: true })
    try {
      const presets = ctx.get('agentPresets')
      const presetId = (await presets.resolve('standard')).id
      handle = await ctx.agents.create({ sessionId, meta: { cwd: job.workspace, agentPreset: presetId },
        agentOptions: { provider: config.provider ?? 'deepseek-account', model: config.model ?? 'deepseek-flash',
          reasoningEffort: config.reasoningEffort ?? 'max', maxTokens },
        async setup(agentCtx, agent) {
          // Match Desktop's session controller: create() does not mount the
          // standard file/shell tool preset automatically.
          await presets.mount(agentCtx, presetId)
          const tools = agentCtx.get('tools')
          tools.restrict({ allow: TOOLS })
          tools.presentAs('native')
          tools.guard(exec => {
            if (summaryPhase) return 'Step budget handoff: tools are disabled; return the checkpoint summary only'
            if (!TOOLS.includes(exec.name)) return 'Tool unavailable in bounded worker'
            if (exec.name === 'bash' && exec.arguments?.run_in_background) return 'Background jobs are unavailable for bounded workers'
            const permission = permissionRefusal(agent)
            if (permission) { failure ??= stopError('WORKSPACE_PERMISSION_VIOLATION', permission); return permission }
            return toolPathRefusal(exec, job)
          })
          agentCtx.on('system-prompt/assemble', async (assembly, context, next) => {
            const result = await next()
            if (String(context.agent?.session?.id) === sessionId && job.maxSteps >= 3 && steps >= job.maxSteps - 1) return { ...result, tools: [] }
            return result
          }, { prepend: true })
          agentCtx.on('agent/pre-step', async (proposal, next) => {
            const permission = permissionRefusal(agent)
            if (permission) { failure ??= stopError('WORKSPACE_PERMISSION_VIOLATION', permission); return { kind: 'reject' } }
            if (steps >= job.maxSteps) { budgetBlocked = true; return { kind: 'reject' } }
            const decision = await next()
            if (decision.kind === 'reject') return decision
            const remaining = job.maxSteps - steps
            let notice
            if (job.maxSteps >= 3 && remaining === 1) {
              summaryPhase = true
              notice = 'BRIDGE BUDGET HANDOFF: this is the final reserved model step. Tools are unavailable. Begin your text with "Step budget handoff — work requires orchestrator review." Summarize completed changes, exact validation commands/results already observed, unfinished work, concrete blockers, and the next smallest action. Do not claim completion or run more work. Preserve all files. The orchestrator can explicitly continue from this checkpoint.'
            } else if (!warned && remaining <= 3) {
              warned = true
              notice = `BRIDGE BUDGET NOTICE: ${remaining} model steps remain${job.maxSteps >= 3 ? ', including one final tool-free summary step' : ''}. Finish the smallest useful checkpoint. Avoid fresh broad investigation or repeated test suites; report remaining work honestly.`
            }
            return notice ? { ...decision, messages: [...decision.messages, userMessage(notice)] } : decision
          }, { prepend: true })
        },
      })
      signal.throwIfAborted()
      // Setup precedes session publication and its default permission seeding.
      // Pin only after create resolves, then verify before admitting model work.
      // The caller injects this service; the driver scope does not inherit it.
      ctx.permissionPresets.set(handle.agent.session, 'workspace-write')
      const permission = permissionRefusal(handle.agent)
      if (permission) throw stopError('WORKSPACE_PERMISSION_VIOLATION', permission)
      permissionsAtAdmission = { preset: 'workspace-write', sandbox: 'workspace-write', approval: 'ask', workspace: job.workspace }
      // Complete identified UserMessage wire shape, as required by followup.
      handle.agent.followup(userMessage(prompt(job)))
      await handle.agent.whenIdle()
      signal.throwIfAborted()
      if (terminal !== 'completed' && !(budgetBlocked && terminal === 'blocked')) throw stopError(
        providerError?.code ?? (terminal === 'blocked' ? 'HARNESS_BLOCKED' : 'WORKER_INCOMPLETE'),
        `Worker did not complete: ${terminal ?? 'missing turn/end'}${providerError ? ` (${providerError.code}: ${providerError.message})` : ''}`)

    } catch (error) {
      failure = error
    } finally {
      signal.removeEventListener('abort', cancel)
      // Disposal drains the worker and its owned Bash jobs before another ticket
      // can use this workspace or evidence can claim a stable final checkout.
      try { if (handle) await handle.dispose() } catch (error) { failure = error } finally { stopEvents() }
    }
    let after
    try { after = await snapshot(job.workspace) } catch (error) { failure ??= error }
    const changedFiles = after ? [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])]
      .filter(name => before.files[name] !== after.files[name]) : []
    const changedIndexPaths = after ? [...new Set([...Object.keys(before.index), ...Object.keys(after.index)])]
      .filter(name => before.index[name] !== after.index[name]) : []
    const changedPaths = [...new Set([...changedFiles, ...changedIndexPaths])].sort()
    const outside = changedPaths.filter(name => !job.ownedPaths.some(owned => name === owned || name.startsWith(`${owned.replace(/\/$/, '')}/`)))
    if (after && before.head !== after.head) failure ??= Object.assign(new Error('Worker changed Git HEAD; review checkout manually'), { code: 'WORKSPACE_SCOPE_VIOLATION' })
    if (outside.length) failure ??= Object.assign(new Error(`Worker changed paths outside ownership: ${outside.join(', ').slice(0, 800)}`), { code: 'WORKSPACE_SCOPE_VIOLATION' })
    const budgetExhausted = budgetBlocked || summaryPhase
    const artifactDir = path.join(config.stateDir, `${job.id}-${job.revisions ?? 0}`)
    const evidence = { head: before.head, changedPaths, before: { sha256: sha256(before.patch), bytes: Buffer.byteLength(before.patch) },
      after: after ? { sha256: sha256(after.patch), bytes: Buffer.byteLength(after.patch) } : null,
      indexBefore: before.indexSha256, indexAfter: after?.indexSha256 ?? null, changedIndexPaths,
      filesBefore: before.files, filesAfter: after?.files ?? null, artifactDir, steps, maxSteps: job.maxSteps, toolCalls, toolErrors, recentTools, budget: { exhausted: budgetExhausted, summaryStepReserved: job.maxSteps >= 3, summaryStepUsed: summaryPhase }, terminal: terminal ?? null, providerError: providerError ?? null,
      permissionsAtAdmission: permissionsAtAdmission ?? null,
      validation: 'worker_report_requires_independent_review', ownership: 'git_visible_changes_only' }
    const evidenceText = `${JSON.stringify(evidence, null, 2)}\n`
    const { filesBefore: omittedBefore, filesAfter: omittedAfter, ...compactEvidence } = evidence
    void omittedBefore; void omittedAfter
    const result = { outcome: budgetExhausted ? 'budget_exhausted' : 'completed',
      summary: summary || (budgetExhausted ? `Step budget exhausted (${steps}/${job.maxSteps}). No final worker summary was produced. Inspect the saved diff and recent tool activity before continuation.` : 'Worker supplied no text summary; inspect session and evidence.'), sessionId,
      usage: { ...usage, complete: usage.missingAttempts === 0 && usage.reportedAttempts > 0 },
      evidence: { ...compactEvidence, evidenceFile: { path: path.join(artifactDir, 'evidence.json'), sha256: sha256(evidenceText), bytes: Buffer.byteLength(evidenceText) } } }
    try {
      await mkdir(artifactDir, { recursive: true, mode: 0o700 })
      await writeFile(path.join(artifactDir, 'before.patch'), before.patch, { mode: 0o600 })
      if (after) await writeFile(path.join(artifactDir, 'after.patch'), after.patch, { mode: 0o600 })
      await writeFile(path.join(artifactDir, 'evidence.json'), evidenceText, { mode: 0o600 })
    } catch (error) { failure ??= error }
    if (failure) {
      // A failed attempt may carry useful evidence, never a success/handoff outcome.
      delete result.outcome
      const error = new Error(String(failure?.message ?? failure), { cause: failure })
      if (failure?.code) error.code = failure.code
      error.name = failure?.name ?? 'Error'
      error.result = result
      throw error
    }
    return result
  }
}
