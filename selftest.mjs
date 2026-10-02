import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
const here = path.dirname(fileURLToPath(import.meta.url))
const result = spawnSync(process.execPath, ['--test', ...['jobs', 'runner', 'server', 'mcp', 'setup'].map(name => path.join(here, `${name}.test.mjs`))], { stdio: 'inherit' })
process.exit(result.status ?? 1)
