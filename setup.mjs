import { mkdir, writeFile, realpath } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// Generate a reviewable overlay; installing/activating it is a separate step.
const here = path.dirname(fileURLToPath(import.meta.url))
const usage = 'Usage: node setup.mjs --workspace=/absolute/path/to/git-checkout [--state-dir=/absolute/path/to/private-state]'
const options = new Map()
for (const arg of process.argv.slice(2)) {
  if (arg === '--help') { console.log(usage); process.exit(0) }
  const match = /^--(workspace|state-dir)=(.+)$/.exec(arg)
  if (!match || options.has(match[1])) throw new Error(usage)
  options.set(match[1], match[2])
}
const requestedWorkspace = options.get('workspace')
if (!requestedWorkspace || !path.isAbsolute(requestedWorkspace)) throw new Error(usage)
const workspace = await realpath(requestedWorkspace)
const gitRoot = await realpath(execFileSync('git', ['-C', workspace, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim())
if (gitRoot !== workspace) throw new Error('--workspace must name the Git checkout root, not a subdirectory')
const requestedState = options.get('state-dir') ?? path.join(here, '.dsh-orchestrator-bridge')
if (!path.isAbsolute(requestedState)) throw new Error('--state-dir must be absolute')
// Validate all arguments before creating files. Never infer scope from this package's parents.
await mkdir(requestedState, { recursive: true, mode: 0o700 })
const stateDir = await realpath(requestedState)
const patchFile = path.join(stateDir, 'plugin.patch.yml')
const connection = path.join(stateDir, 'connection.json')
const quote = value => `'${value.replaceAll("'", "'\\''")}'`
await writeFile(patchFile, [
  '- id: orchestrator-bridge',
  '  config:',
  `    stateDir: ${JSON.stringify(stateDir)}`,
  '    workspaceRoots:',
  `      - ${JSON.stringify(workspace)}`,
  '    provider: deepseek-account',
  '    model: deepseek-flash',
  '    reasoningEffort: max',
  '    maxTokens: 8192',
  '    maxParallel: 2',
  '- id: hmr',
  '  disabled: false',
  '  config:',
  `    base: ${JSON.stringify(`${here}/`)}`,
  '    root: [index.js, jobs.js, runner.js, server.js]',
  '    ignored: ["**/node_modules", "**/.*", cache, data]',
  '    debounce: 100',
  '',
].join('\n'), { mode: 0o600 })
const mcpCommand = `codex mcp add deepseek-worker -- ${quote(process.execPath)} ${quote(path.join(here, 'mcp.mjs'))} ${quote(`--connection=${connection}`)}`
console.log(`Generated overlay: ${patchFile}`)
console.log(`Install local bundle: ${here}`)
console.log(`Boot with overlay: dsh desktop --patch ${quote(patchFile)}`)
console.log(`Register MCP: ${mcpCommand}`)
