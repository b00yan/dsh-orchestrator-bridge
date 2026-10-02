import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { readConnection } from './mcp.mjs';

const script = fileURLToPath(new URL('./mcp.mjs', import.meta.url));
const TOKEN = 'fixture-secret-012345678901234567890123456789';
const submit = { idempotencyKey: 'key-1', task: 'Inspect a fixture', workspace: '/tmp/worktree', ownedPaths: ['fixture.txt'], acceptance: 'Show checked evidence' };

async function fixture(t, { descriptor, handler, env = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mcp-test-'));
  const calls = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    calls.push({ body, headers: request.headers, url: request.url });
    if (handler) return handler(request, response, body);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ result: { method: body.method, args: body.args, state: 'awaiting_review' } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const connection = { version: 1, url: `http://127.0.0.1:${server.address().port}`, token: TOKEN, ...descriptor };
  const connectionPath = join(directory, 'connection.json');
  await writeFile(connectionPath, JSON.stringify(connection));
  const child = spawn(process.execPath, [script, ...(env ? [] : [`--connection=${connectionPath}`])], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, DSH_BRIDGE_CONNECTION: env ? connectionPath : '' } });
  let stderr = '';
  let stdout = '';
  let remainder = '';
  const frames = [];
  const waiters = [];
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    remainder += chunk;
    while (remainder.includes('\n')) {
      const end = remainder.indexOf('\n');
      const line = remainder.slice(0, end);
      remainder = remainder.slice(end + 1);
      let frame;
      try { frame = JSON.parse(line); }
      catch { frame = { invalidFrame: line }; }
      if (waiters.length) waiters.shift()(frame);
      else frames.push(frame);
    }
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    await rm(directory, { recursive: true, force: true });
    assert.equal(stderr, '', 'transport must not log operational errors');
    for (const line of stdout.trim().split('\n').filter(Boolean)) assert.equal(JSON.parse(line).jsonrpc, '2.0', 'stdout contains only JSON-RPC');
    assert.equal(stdout.includes(TOKEN), false, 'credential must never appear on stdout');
  });
  function next(timeoutMs = 5000) {
    if (frames.length) return Promise.resolve(frames.shift());
    return new Promise((done, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for MCP frame')), timeoutMs);
      waiters.push((value) => { clearTimeout(timer); done(value); });
    });
  }
  return { child, server, calls, connectionPath, connection, next, raw: (value) => child.stdin.write(value), request: async (id, method, params) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`);
    return next();
  } };
}

test('actual stdio handshake, protocol negotiation, schemas, notifications and ping', async (t) => {
  const client = await fixture(t);
  for (const protocolVersion of ['2024-11-05', '2025-03-26', '2025-06-18', 'future']) {
    const frame = await client.request(protocolVersion, 'initialize', { protocolVersion, capabilities: {}, clientInfo: { name: 'fixture', version: '1' } });
    assert.equal(frame.id, protocolVersion);
    assert.equal(frame.result.protocolVersion, protocolVersion === 'future' ? '2025-06-18' : protocolVersion);
    assert.deepEqual(frame.result.capabilities, { tools: {} });
    assert.equal(frame.result.serverInfo.version, '1.1.0');
  }
  client.raw('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  client.raw('{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":99}}\n');
  assert.deepEqual((await client.request(5, 'ping')).result, {});
  const { tools } = (await client.request(6, 'tools/list')).result;
  assert.deepEqual(tools.map(({ name }) => name), ['deepseek_submit', 'deepseek_status', 'deepseek_list', 'deepseek_wait', 'deepseek_review', 'deepseek_cancel', 'deepseek_continue', 'deepseek_health']);
  for (const tool of tools) assert.equal(tool.inputSchema.additionalProperties, false);
  assert.deepEqual(tools[0].inputSchema.required, ['idempotencyKey', 'task', 'workspace', 'ownedPaths', 'acceptance']);
  assert.equal(tools[0].inputSchema.properties.timeoutMs.maximum, 3600000);
  assert.equal(tools[0].inputSchema.properties.maxSteps.maximum, 100);
  assert.match(tools[0].description, /untrusted/);
  assert.match(tools[0].description, /budget_exhausted/);
  assert.match(tools[0].description, /final summary slot/);
  assert.match(tools[3].description, /afterRevision/);
  assert.match(tools[3].description, /budget_exhausted/);
  assert.match(tools[1].description, /budget_exhausted/);
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  const continuation = byName.deepseek_continue;
  assert.deepEqual(continuation.inputSchema.required, ['id', 'idempotencyKey', 'feedback']);
  assert.deepEqual(continuation.inputSchema.properties.id, { type: 'string', minLength: 1, pattern: '\\S' });
  assert.deepEqual(continuation.inputSchema.properties.idempotencyKey, { type: 'string', minLength: 1, pattern: '\\S' });
  assert.deepEqual(continuation.inputSchema.properties.feedback, { type: 'string', minLength: 1, pattern: '\\S' });
  assert.deepEqual(continuation.inputSchema.properties.maxSteps, { type: 'integer', minimum: 1, maximum: 100 });
  assert.deepEqual(continuation.inputSchema.properties.timeoutMs, { type: 'integer', minimum: 1000, maximum: 3600000 });
  assert.match(continuation.description, /budget_exhausted/);
  assert.match(continuation.description, /never automatic/);
  assert.match(continuation.description, /untrusted/);
  assert.equal(client.calls.length, 0);
});

test('every tool forwards exact arguments and authorization through the local bridge', async (t) => {
  const client = await fixture(t, { env: true });
  const continuation = { id: 'job-1', idempotencyKey: 'continue-1', feedback: 'Checkpoint reviewed' };
  const cases = [['deepseek_submit', submit], ['deepseek_status', { id: 'job-1' }], ['deepseek_list', {}], ['deepseek_wait', { id: 'job-1', afterRevision: 2, waitMs: 25000 }], ['deepseek_review', { id: 'job-1', decision: 'approve', feedback: 'Checked' }], ['deepseek_cancel', { id: 'job-1' }], ['deepseek_continue', continuation], ['deepseek_continue', { ...continuation, idempotencyKey: 'continue-2', maxSteps: 3, timeoutMs: 60000 }], ['deepseek_continue', { ...continuation, idempotencyKey: 'continue-3', maxSteps: 1, timeoutMs: 1000 }], ['deepseek_continue', { ...continuation, idempotencyKey: 'continue-4', maxSteps: 100, timeoutMs: 3_600_000 }], ['deepseek_health', {}]];
  for (const [method, args] of cases) {
    const frame = await client.request(method, 'tools/call', { name: method, arguments: args });
    assert.equal(frame.id, method);
    assert.equal(frame.result.isError, undefined);
    assert.deepEqual(frame.result.content, [{ type: 'text', text: JSON.stringify({ method, args, state: 'awaiting_review' }) }]);
    const call = client.calls.at(-1);
    assert.deepEqual(call.body, { method, args });
    assert.equal(call.url, '/rpc');
    assert.equal(call.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(call.headers['content-type'], 'application/json');
  }
});

test('invalid arguments and unknown methods are refused before HTTP', async (t) => {
  const client = await fixture(t);
  const bad = [['deepseek_submit', { ...submit, maxSteps: 101 }], ['deepseek_submit', { ...submit, maxSteps: 0 }], ['deepseek_submit', { ...submit, timeoutMs: 999 }], ['deepseek_submit', { ...submit, timeoutMs: 3_600_001 }], ['deepseek_submit', { ...submit, maxSteps: 1.2 }], ['deepseek_submit', { ...submit, ownedPaths: [42] }], ['deepseek_submit', { task: 'missing fields' }], ['deepseek_status', { id: 'job', extra: true }], ['deepseek_status', {}], ['deepseek_wait', { id: 'job', waitMs: 25001 }], ['deepseek_wait', { id: 'job', afterRevision: -1 }], ['deepseek_review', { id: 'job', decision: 'merge' }], ['deepseek_health', { token: 'secret' }], ['deepseek_health', null], ['deepseek_health', []], ['unknown_tool', {}],
    ['deepseek_continue', { idempotencyKey: 'key', feedback: 'Checkpoint reviewed' }],
    ['deepseek_continue', { id: '', idempotencyKey: 'key', feedback: 'Checkpoint reviewed' }],
    ['deepseek_continue', { id: '   ', idempotencyKey: 'key', feedback: 'Checkpoint reviewed' }],
    ['deepseek_continue', { id: 'job', feedback: 'Checkpoint reviewed' }],
    ['deepseek_continue', { id: 'job', idempotencyKey: '', feedback: 'Checkpoint reviewed' }],
    ['deepseek_continue', { id: 'job', idempotencyKey: '   ', feedback: 'Checkpoint reviewed' }],
    ['deepseek_continue', { id: 'job', idempotencyKey: 'key' }],
    ['deepseek_continue', { id: 'job', idempotencyKey: 'key', feedback: '' }],
    ['deepseek_continue', { id: 'job', idempotencyKey: 'key', feedback: '   ' }],
    ['deepseek_continue', { id: 'job', idempotencyKey: 'key', feedback: 7 }],
    ['deepseek_continue', { id: 'job', idempotencyKey: 'key', feedback: 'Checkpoint reviewed', maxSteps: 0 }],
    ['deepseek_continue', { id: 'job', idempotencyKey: 'key', feedback: 'Checkpoint reviewed', maxSteps: 101 }],
    ['deepseek_continue', { id: 'job', idempotencyKey: 'key', feedback: 'Checkpoint reviewed', maxSteps: 2.5 }],
    ['deepseek_continue', { id: 'job', idempotencyKey: 'key', feedback: 'Checkpoint reviewed', maxSteps: '3' }],
    ['deepseek_continue', { id: 'job', idempotencyKey: 'key', feedback: 'Checkpoint reviewed', timeoutMs: 999 }],
    ['deepseek_continue', { id: 'job', idempotencyKey: 'key', feedback: 'Checkpoint reviewed', timeoutMs: 3_600_001 }],
    ['deepseek_continue', { id: 'job', idempotencyKey: 'key', feedback: 'Checkpoint reviewed', timeoutMs: 1000.5 }],
    ['deepseek_continue', { id: 'job', idempotencyKey: 'key', feedback: 'Checkpoint reviewed', parentId: 'job-0' }],
    ['deepseek_continue', null], ['deepseek_continue', []]];
  for (const [name, args] of bad) assert.equal((await client.request(name, 'tools/call', { name, arguments: args })).error.code, -32602);
  assert.equal((await client.request(99, 'unsupported')).error.code, -32601);
  assert.equal((await client.request(100, 'initialize', {})).error.code, -32602);
  assert.equal(client.calls.length, 0);
});

test('tool errors redact credentials and transport failures are MCP tool errors', async (t) => {
  const client = await fixture(t, { handler: (_request, response, body) => {
    if (body.method === 'deepseek_health') { response.statusCode = 401; response.end(TOKEN); }
    else response.end(JSON.stringify({ error: `Worker refused: ${TOKEN}` }));
  } });
  const error = await client.request(1, 'tools/call', { name: 'deepseek_status', arguments: { id: 'job' } });
  assert.equal(error.result.isError, true);
  assert.equal(error.result.content[0].text, 'Worker refused: [redacted]');
  const auth = await client.request(2, 'tools/call', { name: 'deepseek_health', arguments: {} });
  assert.equal(auth.result.isError, true);
  assert.match(auth.result.content[0].text, /HTTP 401/);
  await new Promise((done) => client.server.close(done));
  const disconnected = await client.request(3, 'tools/call', { name: 'deepseek_health', arguments: {} });
  assert.equal(disconnected.result.isError, true);
  assert.match(disconnected.result.content[0].text, /unavailable/);
});

test('connection descriptor refusal rejects noncanonical or remote URLs and never exposes token', async (t) => {
  const client = await fixture(t, { descriptor: { url: `http://${TOKEN}@127.0.0.1:7777` } });
  assert.equal((await client.request(1, 'initialize', { protocolVersion: '2025-06-18' })).result.serverInfo.version, '1.1.0');
  const urls = ['https://127.0.0.1:7777', 'http://localhost:7777', 'http://127.1:7777', 'http://2130706433:7777', 'http://0.0.0.0:7777', 'http://example.com:7777', 'http://127.0.0.1:7777/', 'http://127.0.0.1:7777?x=1', 'http://127.0.0.1:7777#x', 'http://127.0.0.1:65536', `http://${TOKEN}@127.0.0.1:7777`];
  for (const [index, url] of urls.entries()) {
    await writeFile(client.connectionPath, JSON.stringify({ ...client.connection, url }));
    const frame = await client.request(index, 'tools/call', { name: 'deepseek_health', arguments: {} });
    assert.equal(frame.result.isError, true);
    assert.match(frame.result.content[0].text, /descriptor/);
  }
  assert.equal(client.calls.length, 0);
});

test('descriptor byte limit, invalid version/token, and absolute path requirement', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mcp-descriptor-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'connection.json');
  await assert.rejects(readConnection('relative.json'), /absolute path/);
  for (const descriptor of [{ version: 2, url: 'http://127.0.0.1:1', token: TOKEN }, { version: 1, url: 'http://127.0.0.1:1', token: 'short' }, { version: 1, url: 'http://127.0.0.1:1', token: `${TOKEN}\n` }]) {
    await writeFile(path, JSON.stringify(descriptor));
    await assert.rejects(readConnection(path), /descriptor/);
  }
  await writeFile(path, ' '.repeat(16 * 1024 + 1));
  await assert.rejects(readConnection(path), /unreadable or invalid/);
  await writeFile(path, '{broken');
  await assert.rejects(readConnection(path), /unreadable or invalid/);
  await assert.rejects(readConnection(directory), /unreadable or invalid/);
  await assert.rejects(readConnection(join(directory, 'missing.json')), /unreadable or invalid/);
  await writeFile(path, JSON.stringify({ version: 1, url: 'http://[::1]:8787', token: TOKEN }));
  assert.equal((await readConnection(path)).url, 'http://[::1]:8787');
});

test('malformed and oversized lines drain and recover across chunk boundaries', async (t) => {
  const client = await fixture(t);
  client.raw('not JSON\n');
  assert.equal((await client.next()).error.code, -32700);
  client.raw('['.repeat(70 * 1024));
  client.raw('x'.repeat(70 * 1024));
  client.raw('discarded tail\n');
  assert.equal((await client.next()).error.code, -32700);
  assert.deepEqual((await client.request('recovered', 'ping')).result, {});
  client.raw('{"jsonrpc":"1.0","id":1,"method":"ping"}\n');
  assert.equal((await client.next()).error.code, -32600);
  assert.equal((await client.request('still-working', 'ping')).id, 'still-working');
});

test('response limits and malformed payloads fail safely', async (t) => {
  const client = await fixture(t, { handler: (_request, response, body) => {
    if (body.args.id === 'large') response.end(JSON.stringify({ result: { text: 'x'.repeat(1024 * 1024) } }));
    else if (body.args.id === 'primitive') response.end('{"result":1}');
    else response.end('{broken');
  } });
  for (const id of ['large', 'primitive', 'broken']) {
    const frame = await client.request(id, 'tools/call', { name: 'deepseek_status', arguments: { id } });
    assert.equal(frame.result.isError, true);
    assert.match(frame.result.content[0].text, id === 'large' ? /size limit/ : /invalid response/);
  }
});

test('HTTP redirects are refused without contacting another endpoint', async (t) => {
  let redirected = false;
  const client = await fixture(t, { handler: (request, response) => {
    if (request.url === '/redirected') redirected = true;
    response.statusCode = 302;
    response.setHeader('location', '/redirected');
    response.end();
  } });
  const frame = await client.request('redirect', 'tools/call', { name: 'deepseek_health', arguments: {} });
  assert.equal(frame.result.isError, true);
  assert.match(frame.result.content[0].text, /HTTP 302/);
  assert.equal(redirected, false);
  assert.equal(client.calls.length, 1);
});

test('stalled HTTP calls reach the 30-second deadline and stdio remains usable', { timeout: 40_000 }, async (t) => {
  const client = await fixture(t, { handler: () => {} });
  const started = Date.now();
  client.raw(`${JSON.stringify({ jsonrpc: '2.0', id: 'deadline', method: 'tools/call', params: { name: 'deepseek_health', arguments: {} } })}\n`);
  const frame = await client.next(35_000);
  assert.equal(frame.id, 'deadline');
  assert.equal(frame.result.isError, true);
  assert.match(frame.result.content[0].text, /timed out/);
  assert.ok(Date.now() - started >= 29_000, 'deadline must not prematurely cancel a supported long wait');
  assert.deepEqual((await client.request('after-timeout', 'ping')).result, {});
});

test('parallel calls preserve IDs, cap in-flight requests, and recover capacity', async (t) => {
  const responses = [];
  const client = await fixture(t, { handler: (_request, response, body) => { responses.push({ response, body }); } });
  client.raw(Array.from({ length: 33 }, (_, id) => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'deepseek_status', arguments: { id: `job-${id}` } } })).join('\n') + '\n');
  const refused = await client.next();
  assert.equal(refused.id, 32);
  assert.equal(refused.error.code, -32000);
  // Wait for all accepted HTTP calls without depending on their completion order.
  const deadline = Date.now() + 5000;
  while (responses.length < 32 && Date.now() < deadline) await new Promise((done) => setTimeout(done, 10));
  assert.equal(responses.length, 32);
  for (const { response, body } of responses.reverse()) response.end(JSON.stringify({ result: { id: body.args.id } }));
  const seen = new Set();
  for (let count = 0; count < 32; count++) {
    const frame = await client.next();
    assert.equal(JSON.parse(frame.result.content[0].text).id, `job-${frame.id}`);
    seen.add(frame.id);
  }
  assert.equal(seen.size, 32);
  assert.deepEqual((await client.request('capacity-restored', 'ping')).result, {});
});
