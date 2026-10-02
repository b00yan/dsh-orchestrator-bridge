import http from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { realpath, writeFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { JobManager } from './jobs.js'
import { createHarnessRunner, validateContinuation } from './runner.js'

const MAX_BODY = 128 * 1024
const METHODS = new Set(['deepseek_health', 'deepseek_submit', 'deepseek_status', 'deepseek_list', 'deepseek_wait', 'deepseek_review', 'deepseek_cancel', 'deepseek_continue'])

export async function createBridge({ ctx, config, run }) {
  if (!path.isAbsolute(config.stateDir)) throw new Error('stateDir must be absolute')
  if (!Array.isArray(config.workspaceRoots) || !config.workspaceRoots.length) throw new Error('workspaceRoots must be nonempty')
  const roots = await Promise.all(config.workspaceRoots.map(async (root) => {
    if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('workspaceRoots must contain absolute paths')
    return realpath(root)
  }))
  const manager = new JobManager({ stateDir: config.stateDir, maxParallel: config.maxParallel ?? 2,
    run: run ?? createHarnessRunner(ctx, config),
    validateContinuation: parent => validateContinuation(parent, config) })
  await manager.start()
  const token = randomBytes(32).toString('hex')
  const connectionPath = path.join(config.stateDir, 'connection.json')
  let closing = false, closePromise
  const server = http.createServer(async (request, response) => {
    const send = (status, data) => {
      if (response.destroyed) return
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(JSON.stringify(data))
    }
    const actual = Buffer.from(request.headers.authorization ?? '')
    const expected = Buffer.from(`Bearer ${token}`)
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      send(401, { error: 'Unauthorized' }); request.resume(); return
    }
    if (closing) { send(503, { error: 'Bridge is stopping' }); request.resume(); return }
    if (request.method !== 'POST' || request.url !== '/rpc') { send(404, { error: 'Unknown endpoint' }); request.resume(); return }
    if (request.headers.origin || request.headers['content-type'] !== 'application/json') {
      send(400, { error: 'Only local JSON RPC clients are supported' }); request.resume(); return
    }
    try {
      const chunks = []
      let bytes = 0
      for await (const chunk of request) {
        bytes += chunk.length
        if (bytes > MAX_BODY) { send(413, { error: 'Request too large' }); request.destroy(); return }
        chunks.push(chunk)
      }
      const { method, args = {} } = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (!METHODS.has(method) || !args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid method or arguments')
      let result
      switch (method) {
        case 'deepseek_health':
          result = { ready: true, version: 1, bridgeVersion: '1.1.0', provider: config.provider ?? 'deepseek-account',
            model: config.model ?? 'deepseek-flash', maxParallel: config.maxParallel ?? 2,
            workspaceRoots: roots, stateDir: config.stateDir, approval: 'orchestrator_review_required',
            capabilities: { budgetHandoff: true, continuation: true, maxContinuationDepth: 3 } }
          break
        case 'deepseek_submit': {
          if (typeof args.workspace !== 'string' || !path.isAbsolute(args.workspace)) throw new Error('workspace must be absolute')
          const workspace = await realpath(args.workspace)
          if (!roots.some(root => workspace === root || workspace.startsWith(`${root}${path.sep}`))) throw new Error('workspace is outside configured workspaceRoots')
          result = await manager.submit({ ...args, workspace })
          break
        }
        case 'deepseek_status': result = await manager.status(args.id); break
        case 'deepseek_list': result = await manager.list(); break
        case 'deepseek_wait': result = await manager.wait(args.id, args.afterRevision, args.waitMs); break
        case 'deepseek_review': result = await manager.review(args); break
        case 'deepseek_cancel': result = await manager.cancel(args.id); break
        case 'deepseek_continue': result = await manager.continue(args); break
      }
      send(200, { result })
    } catch (error) {
      send(200, { error: String(error?.message ?? error).slice(0, 1000).replaceAll(token, '[redacted]') })
    }
  })
  server.requestTimeout = 30_000
  server.headersTimeout = 10_000
  server.maxConnections = 32
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const descriptor = { version: 1, url: `http://127.0.0.1:${server.address().port}`, token }
    const temporary = `${connectionPath}.tmp`
    await writeFile(temporary, `${JSON.stringify(descriptor)}\n`, { mode: 0o600 })
    await rename(temporary, connectionPath)
  } catch (error) {
    server.close(); await manager.close(); throw error
  }
  return { manager, connectionPath, close() {
    if (closePromise) return closePromise
    closing = true
    closePromise = (async () => {
      try { await rm(connectionPath, { force: true }) }
      finally {
        server.closeIdleConnections()
        server.closeAllConnections()
        try { await new Promise(resolve => server.close(resolve)) }
        finally { await manager.close() }
      }
    })()
    return closePromise
  } }
}
