import { createBridge } from './server.js'

export const name = 'orchestrator-bridge'
export const inject = ['agents', 'permissionPresets', 'agentPresets']

export async function apply(ctx, config = {}) {
  if (!config.stateDir || !config.workspaceRoots?.length) {
    ctx.logger?.warn?.('orchestrator-bridge disabled: configure absolute stateDir and workspaceRoots using setup.mjs')
    return
  }
  const bridge = await createBridge({ ctx, config })
  ctx.effect(() => () => bridge.close())
  ctx.logger?.info?.(`orchestrator-bridge ready; connection descriptor: ${bridge.connectionPath}`)
}
