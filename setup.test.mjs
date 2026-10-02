import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, statSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const setup = fileURLToPath(new URL('./setup.mjs', import.meta.url))
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-setup-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const workspace = path.join(root, "checkout with 'quotes'")
  mkdirSync(workspace)
  execFileSync('git', ['init', '-q', workspace])
  const state = path.join(root, 'private state')
  const run = (...args) => spawnSync(process.execPath, [setup, ...args], { cwd: root, encoding: 'utf8' })
  return { root, workspace, state, run }
}

test('standalone setup configures only the explicit checkout and state directory', t => {
  const f = fixture(t)
  const r = f.run(`--workspace=${f.workspace}`, `--state-dir=${f.state}`)
  assert.equal(r.status, 0, r.stderr)
  const overlay = path.join(f.state, 'plugin.patch.yml')
  const text = readFileSync(overlay, 'utf8')
  // realpath can canonicalize /var to /private/var on macOS.
  const root = execFileSync('git', ['-C', f.workspace, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
  const configuredRoots = [...text.matchAll(/^      - (.+)$/gm)].map(match => JSON.parse(match[1]))
  assert.deepEqual(configuredRoots, [realpathSync(root)])
  const configuredState = JSON.parse(/^    stateDir: (.+)$/m.exec(text)[1])
  assert.equal(configuredState, realpathSync(f.state))
  assert.match(text, /provider: deepseek-account/)
  assert.match(r.stdout, /Register MCP: codex mcp add deepseek-worker -- /)
  assert.ok(r.stdout.includes('--connection='))
  assert.equal(existsSync(path.join(f.state, 'connection.json')), false, 'setup must not create credentials')
  if (process.platform !== 'win32') assert.equal(statSync(overlay).mode & 0o777, 0o600)
})

test('missing, relative, duplicate and unknown arguments refuse without writing state', t => {
  const f = fixture(t)
  for (const args of [[], ['--workspace=.'], [`--workspace=${f.workspace}`, '--state-dir=relative'], [`--workspace=${f.workspace}`, `--workspace=${f.workspace}`], [`--workspace=${f.workspace}`, '--unknown=yes']]) {
    const r = f.run(...args, ...(args.some(arg => arg.startsWith('--state-dir=')) ? [] : [`--state-dir=${f.state}`]))
    assert.notEqual(r.status, 0, JSON.stringify(args))
    assert.equal(existsSync(f.state), false)
    if (args.includes('--state-dir=relative')) {
      assert.match(r.stderr, /--state-dir must be absolute/)
      assert.equal(existsSync(path.join(f.root, 'relative')), false)
    }
  }
})

test('non-Git directories and checkout subdirectories refuse before writing state', t => {
  const f = fixture(t)
  const sub = path.join(f.workspace, 'sub')
  mkdirSync(sub)
  for (const workspace of [f.root, sub]) {
    const r = f.run(`--workspace=${workspace}`, `--state-dir=${f.state}`)
    assert.notEqual(r.status, 0, workspace)
    assert.equal(existsSync(f.state), false)
  }
})

test('help describes explicit workspace setup without writing files', t => {
  const f = fixture(t)
  const r = f.run('--help')
  assert.equal(r.status, 0)
  assert.match(r.stdout, /--workspace=/)
  assert.equal(existsSync(f.state), false)
})
