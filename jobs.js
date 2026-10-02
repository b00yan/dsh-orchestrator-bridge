import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises'
import { hostname } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const STATES = new Set(['queued', 'running', 'awaiting_review', 'approved', 'rejected', 'failed', 'cancelled', 'interrupted', 'budget_exhausted'])
const TERMINAL = new Set(['approved', 'rejected', 'failed', 'cancelled', 'interrupted', 'budget_exhausted'])
const MAX_TEXT = 16_000
const clone = (value) => structuredClone(value)

function string(value, label, max = MAX_TEXT) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new Error(`${label} must be a nonempty string of at most ${max} characters`)
  return value.trim()
}

function integer(value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label} must be an integer between ${min} and ${max}`)
  return value
}

function ticketShape(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('ticket must be an object')
  const allowed = new Set(['idempotencyKey', 'task', 'workspace', 'ownedPaths', 'acceptance', 'timeoutMs', 'maxSteps'])
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new Error('ticket contains an unknown field')
  if (!Array.isArray(input.ownedPaths) || !input.ownedPaths.length || input.ownedPaths.length > 100) throw new Error('ownedPaths must contain between 1 and 100 paths')
  const ownedPaths = [...new Set(input.ownedPaths.map((value) => {
    const relative = string(value, 'owned path', 1024)
    if (path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative) || relative.includes('\\') || relative.split('/').includes('..')) throw new Error('ownedPaths must be relative repository paths without ..')
    const normalized = path.posix.normalize(relative).replace(/\/$/, '')
    if (normalized === '.' || normalized === '.git' || normalized.startsWith('.git/')) throw new Error('ownedPaths must name repository files or directories outside .git')
    return normalized
  }))].sort()
  return {
    idempotencyKey: string(input.idempotencyKey, 'idempotencyKey', 200),
    task: string(input.task, 'task'),
    workspace: string(input.workspace, 'workspace', 4096),
    ownedPaths,
    acceptance: string(input.acceptance, 'acceptance'),
    timeoutMs: integer(input.timeoutMs ?? 600_000, 'timeoutMs', 1, 3_600_000),
    maxSteps: integer(input.maxSteps ?? 12, 'maxSteps', 1, 100),
  }
}

const fingerprint = (ticket, continuation) => createHash('sha256').update(JSON.stringify(continuation ? { ticket, continuation } : ticket)).digest('hex')
const validCode = (value) => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(value)
const legacyBudget = (job) => job.error === 'Worker exhausted its model-step budget' && job.result?.evidence?.terminal === 'blocked' && job.result.evidence.steps === job.ticket.maxSteps

function continuationShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !['parentJobId', 'depth', 'feedback'].includes(key))) throw new Error('malformed continuation lineage')
  if (typeof value.parentJobId !== 'string' || !/^[0-9a-f-]{36}$/.test(value.parentJobId)) throw new Error('malformed continuation parent')
  return { parentJobId: value.parentJobId, depth: integer(value.depth, 'continuation depth', 1, 3), feedback: string(value.feedback, 'continuation feedback') }
}

// Runner evidence is descriptive; it never establishes acceptance. Limit the
// complete JSON payload, including object keys, before accepting it into state.
function bounded(value, maxBytes = 32_000) {
  const encoded = JSON.stringify(value)
  if (encoded === undefined || Buffer.byteLength(encoded) > maxBytes) throw new Error('runner payload exceeds its bounded JSON size')
  return JSON.parse(encoded)
}

function resultShape(value) {
  if (!value || typeof value !== 'object' || typeof value.summary !== 'string') throw new Error('runner must return a summary string')
  const result = { summary: value.summary.slice(0, MAX_TEXT) }
  if (value.sessionId !== undefined) result.sessionId = string(value.sessionId, 'sessionId', 256)
  for (const key of ['usage', 'evidence']) if (value[key] !== undefined) result[key] = bounded(value[key])
  if (value.outcome !== undefined) {
    if (!['completed', 'budget_exhausted'].includes(value.outcome)) throw new Error('runner outcome must be completed or budget_exhausted')
    result.outcome = value.outcome
  }
  return result
}

// Count JSON escaping as well as UTF-8 bytes, and never split a code point.
// Compact displays have smaller budgets; full status retains the original text.
function compactText(value, maxBytes) {
  if (Buffer.byteLength(JSON.stringify(value)) <= maxBytes) return value
  let used = Buffer.byteLength(JSON.stringify('…'))
  let prefix = ''
  for (const character of value) {
    const bytes = Buffer.byteLength(JSON.stringify(character)) - 2
    if (used + bytes > maxBytes) break
    prefix += character
    used += bytes
  }
  return `${prefix}…`
}

function alive(owner) {
  if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.token !== 'string' || !owner.token || owner.host !== hostname()) throw new Error('owner lock is malformed or belongs to another host; refusing recovery')
  try { process.kill(owner.pid, 0); return true } catch (error) {
    if (error.code === 'ESRCH') return false
    if (error.code === 'EPERM') return true
    throw error
  }
}

/** Durable single-writer queue. Owned paths are prompt scope, not a sandbox. */
export class JobManager {
  constructor({ stateDir, maxParallel = 2, maxJobs = 100, run, now = Date.now, validateContinuation }) {
    this.stateDir = path.resolve(string(stateDir, 'stateDir', 4096))
    this.maxParallel = integer(maxParallel, 'maxParallel', 1, 8)
    this.maxJobs = integer(maxJobs, 'maxJobs', 1, 1000)
    if (typeof run !== 'function' || typeof now !== 'function') throw new Error('run and now must be functions')
    if (validateContinuation !== undefined && typeof validateContinuation !== 'function') throw new Error('validateContinuation must be a function')
    this.run = run
    this.now = now
    this.validateContinuation = validateContinuation
    this.jobs = new Map()
    this.active = new Map()
    this.listeners = new Set()
    this.serial = Promise.resolve()
    this.started = false
    this.closed = false
    this.lockPath = path.join(this.stateDir, 'owner.lock')
    this.statePath = path.join(this.stateDir, 'jobs.json')
  }

  async start() {
    if (this.started || this.closed) throw new Error('manager has already started or closed')
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 })
    await this._lock()
    try {
      let stored
      try {
        if ((await stat(this.statePath)).size > 100_000_000) throw new Error('state file exceeds its size bound')
        stored = JSON.parse(await readFile(this.statePath, 'utf8'))
      } catch (error) { if (error.code !== 'ENOENT') throw error }
      if (stored !== undefined) {
        if (stored?.version !== 1 || !Array.isArray(stored.jobs) || stored.jobs.length > this.maxJobs) throw new Error('malformed or oversized persisted job state')
        const keys = new Set()
        for (const job of stored.jobs) {
          const fields = new Set(['id', 'ticket', 'fingerprint', 'status', 'revision', 'revisions', 'createdAt', 'updatedAt', 'feedback', 'result', 'progress', 'error', 'stopReason', 'continuation'])
          if (!job || typeof job !== 'object' || Array.isArray(job) || Object.keys(job).some((key) => !fields.has(key))) throw new Error('malformed persisted job fields')
          const ticket = ticketShape(job.ticket)
          if (job.continuation !== undefined && JSON.stringify(continuationShape(job.continuation)) !== JSON.stringify(job.continuation)) throw new Error('malformed persisted continuation')
          if (JSON.stringify(ticket) !== JSON.stringify(job.ticket) || typeof job.id !== 'string' || !/^[0-9a-f-]{36}$/.test(job.id) || this.jobs.has(job.id) || keys.has(ticket.idempotencyKey) || !path.isAbsolute(ticket.workspace) || fingerprint(ticket, job.continuation) !== job.fingerprint || !STATES.has(job.status)) throw new Error('malformed persisted job')
          integer(job.revision, 'persisted revision', 1, Number.MAX_SAFE_INTEGER)
          integer(job.revisions, 'persisted revisions', 0, 2)
          for (const key of ['createdAt', 'updatedAt']) if (!Number.isFinite(job[key])) throw new Error('malformed persisted timestamp')
          if (job.feedback !== undefined) string(job.feedback, 'persisted feedback')
          if (job.result !== undefined && JSON.stringify(resultShape(job.result)) !== JSON.stringify(job.result)) throw new Error('malformed persisted result')
          if (['awaiting_review', 'approved'].includes(job.status) && !job.result) throw new Error('persisted review state has no result')
          if (job.progress !== undefined) bounded(job.progress, 4096)
          if (job.error !== undefined) string(job.error, 'persisted error', 2000)
          if (job.stopReason !== undefined && (!job.stopReason || Array.isArray(job.stopReason) || Object.keys(job.stopReason).some((key) => key !== 'code') || !validCode(job.stopReason.code))) throw new Error('malformed persisted stop reason')
          if (job.status === 'failed' && legacyBudget(job)) {
            job.status = 'budget_exhausted'
            job.stopReason = { code: 'STEP_BUDGET_EXHAUSTED' }
            job.revision += 1
            job.updatedAt = this.now()
          }
          if (job.status === 'budget_exhausted' && (!job.result || job.stopReason?.code !== 'STEP_BUDGET_EXHAUSTED' || (job.result.outcome !== 'budget_exhausted' && !legacyBudget(job)))) throw new Error('malformed persisted budget handoff')
          if (['awaiting_review', 'approved'].includes(job.status) && job.result?.outcome === 'budget_exhausted') throw new Error('budget handoff cannot be approved')
          if (job.status === 'queued' || job.status === 'running') {
            job.status = 'interrupted'
            job.error = 'Bridge restarted before this job completed; it was not replayed.'
            job.stopReason = { code: 'INTERRUPTED' }
            job.revision += 1
            job.updatedAt = this.now()
          }
          keys.add(ticket.idempotencyKey)
          this.jobs.set(job.id, job)
        }
        this._validateChains()
      }
      await this._persist()
      this.started = true
      return this
    } catch (error) {
      this.jobs.clear()
      await this._unlock()
      throw new Error(`Cannot load job state: ${error.message}`)
    }
  }

  async _lock() {
    this.owner = { pid: process.pid, host: hostname(), token: randomUUID() }
    const acquire = async () => {
      const handle = await open(this.lockPath, 'wx', 0o600)
      try { await handle.writeFile(JSON.stringify(this.owner)); await handle.sync() } finally { await handle.close() }
    }
    try { await acquire(); return } catch (error) { if (error.code !== 'EEXIST') throw error }
    const old = JSON.parse(await readFile(this.lockPath, 'utf8'))
    if (alive(old)) throw new Error('job state already has a live owner')
    // Serialize stale-owner reclamation. A leftover reclamation guard refuses
    // startup instead of risking deletion of a newer writer's lock.
    const guardPath = `${this.lockPath}.reclaim`
    const guard = await open(guardPath, 'wx', 0o600)
    try {
      const current = JSON.parse(await readFile(this.lockPath, 'utf8'))
      if (current.token !== old.token || alive(current)) throw new Error('job state owner changed during recovery')
      await unlink(this.lockPath)
      await acquire()
    } finally { await guard.close(); await unlink(guardPath) }
  }

  async _unlock() {
    if (!this.owner) return
    const owner = JSON.parse(await readFile(this.lockPath, 'utf8'))
    if (owner.token !== this.owner.token) throw new Error('job owner lock changed unexpectedly')
    await unlink(this.lockPath)
    this.owner = undefined
  }

  _ready() {
    if (!this.started || this.closed) throw new Error('job manager is not running')
    if (this.fatal) throw new Error(`job persistence failed: ${this.fatal.message}`)
  }

  _operation(fn) {
    const operation = this.serial.then(fn)
    this.serial = operation.catch(() => {})
    return operation
  }

  async _persist() {
    const temporary = `${this.statePath}.${randomUUID()}.tmp`
    try {
      const handle = await open(temporary, 'wx', 0o600)
      try { await handle.writeFile(JSON.stringify({ version: 1, jobs: [...this.jobs.values()] })); await handle.sync() } finally { await handle.close() }
      await rename(temporary, this.statePath)
      const directory = await open(this.stateDir, 'r')
      try { await directory.sync() } finally { await directory.close() }
    } catch (error) {
      await unlink(temporary).catch(() => {})
      this.fatal = error
      for (const active of this.active.values()) active.controller.abort()
      throw error
    }
  }

  async _change(job, values) {
    Object.assign(job, values, { revision: job.revision + 1, updatedAt: this.now() })
    await this._persist()
    for (const notify of this.listeners) notify(job.id)
  }

  _job(id) {
    const job = this.jobs.get(id)
    if (!job) throw new Error('unknown job id')
    return job
  }

  _validateChains() {
    const parents = new Set()
    for (const job of this.jobs.values()) {
      if (!job.continuation) continue
      const parent = this.jobs.get(job.continuation.parentJobId)
      if (!parent || parent.status !== 'budget_exhausted' || parents.has(parent.id)) throw new Error('invalid continuation parent or duplicate child')
      parents.add(parent.id)
      if (job.continuation.depth !== (parent.continuation?.depth ?? 0) + 1) throw new Error('invalid continuation chain depth')
      for (const key of ['task', 'workspace', 'ownedPaths', 'acceptance']) if (JSON.stringify(job.ticket[key]) !== JSON.stringify(parent.ticket[key])) throw new Error('continuation changed inherited scope')
      const visited = new Set([job.id])
      let ancestor = parent
      while (ancestor) {
        if (visited.has(ancestor.id)) throw new Error('continuation chain contains a cycle')
        visited.add(ancestor.id)
        ancestor = ancestor.continuation ? this.jobs.get(ancestor.continuation.parentJobId) : undefined
      }
    }
  }

  _snapshot(job) {
    const { ticket, fingerprint: ignored, ...state } = job
    void ignored
    const snapshot = { ...ticket, ...state }
    if (job.continuation) snapshot.continuation = { ...job.continuation, previousResult: this._job(job.continuation.parentJobId).result }
    return clone(snapshot)
  }

  _compact(job) {
    const snapshot = this._snapshot(job)
    for (const key of ['task', 'acceptance', 'ownedPaths', 'idempotencyKey']) delete snapshot[key]
    for (const key of ['workspace', 'feedback', 'error']) if (snapshot[key] !== undefined) snapshot[key] = compactText(snapshot[key], 1000)
    if (snapshot.result) snapshot.result = {
      summary: compactText(snapshot.result.summary, 1000),
      ...(snapshot.result.sessionId ? { sessionId: compactText(snapshot.result.sessionId, 256) } : {}),
      ...(snapshot.result.outcome ? { outcome: snapshot.result.outcome } : {}),
    }
    if (snapshot.continuation) snapshot.continuation = { parentJobId: snapshot.continuation.parentJobId, depth: snapshot.continuation.depth }
    if (snapshot.progress && Buffer.byteLength(JSON.stringify(snapshot.progress)) > 1000) snapshot.progress = { summary: compactText(JSON.stringify(snapshot.progress), 900), truncated: true }
    return snapshot
  }

  async submit(input) {
    this._ready()
    const ticket = ticketShape(input)
    const workspace = await realpath(ticket.workspace)
    const { stdout } = await exec('git', ['-C', workspace, 'rev-parse', '--show-toplevel'], { timeout: 5000, maxBuffer: 8192 })
    ticket.workspace = await realpath(stdout.trim())
    if (workspace !== ticket.workspace) throw new Error('workspace must be the root of an existing Git worktree')
    return this._operation(async () => {
      this._ready()
      const identity = fingerprint(ticket)
      const previous = [...this.jobs.values()].find((job) => job.ticket.idempotencyKey === ticket.idempotencyKey)
      if (previous) {
        if (previous.fingerprint !== identity) throw new Error('idempotencyKey was already used with a different ticket')
        return this._compact(previous)
      }
      if (this.jobs.size >= this.maxJobs) throw new Error('job retention limit reached; refusing to evict idempotency history')
      const job = { id: randomUUID(), ticket, fingerprint: identity, status: 'queued', revision: 1, revisions: 0, createdAt: this.now(), updatedAt: this.now() }
      this.jobs.set(job.id, job)
      await this._persist()
      this._schedule()
      return this._compact(job)
    })
  }

  async status(id) {
    return this._operation(() => { this._ready(); return this._snapshot(this._job(id)) })
  }

  async continue(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['id', 'idempotencyKey', 'feedback', 'maxSteps', 'timeoutMs'].includes(key))) throw new Error('invalid continuation request fields')
    const id = string(input.id, 'id', 36)
    const idempotencyKey = string(input.idempotencyKey, 'idempotencyKey', 200)
    const feedback = string(input.feedback, 'feedback')
    if (Object.hasOwn(input, 'maxSteps')) integer(input.maxSteps, 'maxSteps', 1, 100)
    if (Object.hasOwn(input, 'timeoutMs')) integer(input.timeoutMs, 'timeoutMs', 1, 3_600_000)
    return this._operation(async () => {
      this._ready()
      const parent = this._job(id)
      if (parent.status !== 'budget_exhausted') throw new Error('only budget_exhausted jobs can be continued')
      const continuation = { parentJobId: parent.id, depth: (parent.continuation?.depth ?? 0) + 1, feedback }
      integer(continuation.depth, 'continuation depth', 1, 3)
      const ticket = { ...parent.ticket, idempotencyKey, maxSteps: input.maxSteps ?? parent.ticket.maxSteps, timeoutMs: input.timeoutMs ?? parent.ticket.timeoutMs }
      const identity = fingerprint(ticket, continuation)
      const previous = [...this.jobs.values()].find((job) => job.ticket.idempotencyKey === idempotencyKey)
      if (previous) {
        if (previous.fingerprint !== identity) throw new Error('idempotencyKey was already used with a different continuation request')
        return this._compact(previous)
      }
      if ([...this.jobs.values()].some((job) => job.continuation?.parentJobId === parent.id)) throw new Error('parent already has a continuation child')
      if (this.jobs.size >= this.maxJobs) throw new Error('job retention limit reached; refusing to evict idempotency history')
      if (this.validateContinuation) await this.validateContinuation(this._snapshot(parent))
      const child = { id: randomUUID(), ticket, continuation, fingerprint: identity, feedback, status: 'queued', revision: 1, revisions: 0, createdAt: this.now(), updatedAt: this.now() }
      this.jobs.set(child.id, child)
      await this._persist()
      this._schedule()
      return this._compact(child)
    })
  }

  async list() {
    return this._operation(() => { this._ready(); return [...this.jobs.values()].map((job) => this._compact(job)) })
  }

  _schedule() {
    void this._operation(async () => {
      if (this.closed || this.fatal) return
      for (const job of this.jobs.values()) {
        if (this.active.size >= this.maxParallel) break
        if (job.status !== 'queued' || [...this.active.values()].some((entry) => entry.workspace === job.ticket.workspace)) continue
        await this._change(job, { status: 'running' })
        const active = { workspace: job.ticket.workspace, controller: new AbortController() }
        this.active.set(job.id, active)
        active.done = this._execute(job, active)
      }
    }).catch(() => {})
  }

  async _execute(job, active) {
    const abort = (status, error, code) => {
      if (!active.stop) active.stop = { status, error, stopReason: { code } }
      active.controller.abort()
    }
    active.abort = abort
    const timer = setTimeout(() => abort('failed', 'Job deadline exceeded.', 'DEADLINE_EXCEEDED'), job.ticket.timeoutMs)
    try {
      const value = await this.run(this._snapshot(job), {
        signal: active.controller.signal,
        onProgress: (progress) => this._operation(async () => {
          if (active.controller.signal.aborted || job.status !== 'running' || this.fatal) return
          await this._change(job, { progress: bounded(progress, 4096) })
        }),
      })
      const result = resultShape(value)
      await this._operation(async () => {
        if (this.fatal) return
        if (active.stop) delete result.outcome
        await this._change(job, active.stop ? { ...active.stop, result } : result.outcome === 'budget_exhausted'
          ? { status: 'budget_exhausted', result, error: undefined, stopReason: { code: 'STEP_BUDGET_EXHAUSTED' } }
          : { status: 'awaiting_review', result, error: undefined, stopReason: undefined })
      })
    } catch (error) {
      let result
      let message = String(error?.message ?? error).slice(0, 2000) || 'Runner failed.'
      if (error?.result !== undefined) {
        try { result = resultShape(error.result) } catch { message = `${message.slice(0, 1900)} Failure evidence exceeded its validated bounds.` }
      }
      if (!result && job.result) result = resultShape(job.result)
      if (result) delete result.outcome
      await this._operation(async () => {
        if (this.fatal) return
        await this._change(job, { ...(result ? { result } : {}), ...(active.stop ?? { status: 'failed', error: message, stopReason: { code: validCode(error?.code) ? error.code : 'RUNNER_FAILED' } }) })
      }).catch(() => {})
    } finally {
      clearTimeout(timer)
      this.active.delete(job.id)
      this._schedule()
    }
  }

  async review({ id, decision, feedback }) {
    if (!['approve', 'revise', 'reject'].includes(decision)) throw new Error('review decision must be approve, revise, or reject')
    if (feedback !== undefined) feedback = string(feedback, 'feedback')
    if (decision === 'revise' && feedback === undefined) throw new Error('revision requires feedback')
    return this._operation(async () => {
      this._ready()
      const job = this._job(id)
      if (job.status !== 'awaiting_review') throw new Error('only awaiting_review jobs can be reviewed')
      if (decision === 'revise' && job.revisions >= 2) throw new Error('job revision limit reached')
      await this._change(job, decision === 'revise'
        ? { status: 'queued', feedback, revisions: job.revisions + 1, progress: undefined }
        : { status: decision === 'approve' ? 'approved' : 'rejected', ...(feedback === undefined ? {} : { feedback }) })
      if (decision === 'revise') this._schedule()
      return this._snapshot(job)
    })
  }

  async cancel(id) {
    const result = await this._operation(async () => {
      this._ready()
      const job = this._job(id)
      const active = this.active.get(id)
      if (active) {
        active.abort('cancelled', 'Job cancelled.', 'CANCELLED')
        return { done: active.done }
      }
      if (!TERMINAL.has(job.status)) await this._change(job, { status: 'cancelled', stopReason: { code: 'CANCELLED' } })
      return {}
    })
    if (result.done) await result.done
    return this.status(id)
  }

  async wait(id, afterRevision, waitMs = 25_000) {
    integer(waitMs, 'waitMs', 0, 25_000)
    if (afterRevision !== undefined) integer(afterRevision, 'afterRevision', 0, Number.MAX_SAFE_INTEGER)
    return new Promise((resolve, reject) => {
      let timer
      let settled = false
      const cleanup = () => { clearTimeout(timer); this.listeners.delete(notify) }
      const finish = (value, error) => {
        if (settled) return
        settled = true
        cleanup()
        if (error) reject(error); else resolve(value)
      }
      const check = async (force = false) => {
        try {
          const snapshot = await this._operation(() => { this._ready(); return this._compact(this._job(id)) })
          if (force || afterRevision === undefined || snapshot.revision > afterRevision || TERMINAL.has(snapshot.status) || snapshot.status === 'awaiting_review') finish(snapshot)
        } catch (error) { finish(undefined, error) }
      }
      const notify = (changedId) => { if (changedId === id || changedId === undefined) void check() }
      this.listeners.add(notify)
      timer = setTimeout(() => { void check(true) }, waitMs)
      void check(waitMs === 0)
    })
  }

  async close() {
    if (this.closing) return this.closing
    this.closing = (async () => {
      if (!this.started) return
      let shutdownError
      const running = await this._operation(async () => {
        this.closed = true
        for (const entry of this.active.values()) entry.abort('interrupted', 'Bridge stopped before this job completed.', 'INTERRUPTED')
        try {
          for (const job of this.jobs.values()) if (job.status === 'queued' && !this.fatal) await this._change(job, { status: 'interrupted', error: 'Bridge stopped before this job started.', stopReason: { code: 'INTERRUPTED' } })
        } catch (error) { shutdownError = error }
        for (const notify of this.listeners) notify(undefined)
        return [...this.active.values()].map((entry) => entry.done)
      })
      await Promise.all(running)
      await this.serial
      await this._unlock()
      this.started = false
      if (shutdownError) throw shutdownError
    })()
    return this.closing
  }
}
