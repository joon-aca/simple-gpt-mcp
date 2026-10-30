import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { upstreamFixture } from './upstream-fixture.js';

async function connect(dataDir: string, baseURL: string) {
  let stderr = '';
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve('dist/index.js')],
    env: {
      PATH: process.env.PATH ?? '',
      OPENAI_API_KEY: 'synthetic-key',
      OPENAI_LOG: 'debug',
      OPENAI_MODEL: 'test-model',
      SIMPLE_GPT_MCP_DATA_DIR: dataDir,
      OPENAI_BASE_URL: baseURL,
    },
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const client = new Client(
    { name: 'simple-gpt-mcp-protocol-test', version: '1.0.0' },
    { capabilities: {} },
  );
  await client.connect(transport);
  return {
    client,
    transport,
    stderr: () => stderr,
    close: () => client.close(),
    call: async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool(
        { name, arguments: args },
        { timeout: 10_000 },
      );
      return {
        data: result.structuredContent as Record<string, unknown>,
        isError: result.isError,
        content: result.content,
      };
    },
  };
}

test('actual stdio server works through the official MCP client and OpenAI SDK', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'simple-gpt-mcp-protocol-'));
  const upstream = await upstreamFixture();
  t.after(async () => {
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  });
  let host = await connect(dir, upstream.baseURL);
  try {
    const tools = await host.client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name),
      ['chat', 'sessions', 'request_status'],
    );
    const empty = await host.call('sessions', { operation: 'list' });
    assert.deepEqual(empty.data.sessions, []);
    const invalid = await host.client.callTool({
      name: 'chat',
      arguments: { message: 'x', functions: [] },
    });
    assert.equal(invalid.isError, true);
    assert.equal(upstream.posts.length, 0);
    const first = await host.call('chat', {
      message: 'PRIVATE_PROMPT',
      instructions: 'PRIVATE_INSTRUCTIONS',
      request_id: randomUUID(),
    });
    assert.equal(first.isError, false);
    assert.equal(first.data.message, 'fixture answer');
    assert.deepEqual(first.data.usage, {
      input_tokens: 12,
      output_tokens: 7,
      total_tokens: 19,
      cached_input_tokens: 2,
      reasoning_tokens: 3,
    });
    assert.equal(upstream.posts[0]?.store, true);
    assert.equal(upstream.posts[0]?.truncation, 'disabled');
    assert.equal(upstream.posts[0]?.instructions, 'PRIVATE_INSTRUCTIONS');
    assert(!host.stderr().includes('PRIVATE_'));
    assert(!host.stderr().includes('synthetic-key'));
    const initialId = first.data.session_id;
    await host.close();
    host = await connect(dir, upstream.baseURL);
    const next = await host.call('chat', {
      session_id: initialId,
      message: 'after restart',
      model: 'override-model',
    });
    assert.equal(next.isError, false);
    assert.equal(
      upstream.posts[1]?.previous_response_id,
      first.data.response_id,
    );
    assert.equal(upstream.posts[1]?.instructions, 'PRIVATE_INSTRUCTIONS');
    assert.equal(upstream.posts[1]?.model, 'override-model');
    const metadata = await host.call('sessions', {
      operation: 'get',
      session_id: initialId,
    });
    assert(!JSON.stringify(metadata.data).includes('PRIVATE_'));
  } finally {
    await host.close();
  }
});

test('SDK streaming interruption recovers by GET without repeating POST', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'simple-gpt-mcp-recovery-'));
  const upstream = await upstreamFixture();
  const host = await connect(dir, upstream.baseURL);
  t.after(async () => {
    await host.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  });
  const request_id = randomUUID();
  const lost = await host.call('chat', { message: '[drop]', request_id });
  assert.equal(lost.data.status, 'recovery_required');
  assert.equal(lost.isError, true);
  assert(lost.data.response_id);
  const replay = await host.call('chat', { message: '[drop]', request_id });
  assert.equal(replay.data.cached, true);
  const recovered = await host.call('request_status', {
    request_id,
    action: 'recover',
  });
  assert.equal(recovered.data.status, 'completed');
  assert.equal(upstream.posts.length, 1);
  assert.equal(upstream.gets.length, 1);
  assert.equal(recovered.data.response_id, lost.data.response_id);
});

test('public results distinguish incomplete, failed, refused and rejected responses', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'simple-gpt-mcp-status-'));
  const upstream = await upstreamFixture();
  const host = await connect(dir, upstream.baseURL);
  t.after(async () => {
    await host.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  });
  for (const [message, status] of [
    ['[incomplete]', 'incomplete'],
    ['[failed]', 'failed'],
    ['[refusal]', 'refused'],
    ['[reject]', 'failed'],
  ]) {
    const result = await host.call('chat', { message });
    assert.equal(result.data.status, status);
    assert.equal(result.isError, true);
    assert(!JSON.stringify(result).includes('PRIVATE_UPSTREAM_SECRET'));
    if (message === '[reject]')
      assert.deepEqual(result.data.error, {
        code: 'UPSTREAM_ERROR',
        message:
          'OpenAI rejected the request (unsupported_parameter: reasoning.effort). Check model access and supported options.',
        upstream_request_id: 'req_rejected',
        upstream_code: 'unsupported_parameter',
        upstream_param: 'reasoning.effort',
      });
  }
  assert.equal(upstream.posts.length, 4);
});

test('two actual server processes reject overlap and enforce a total stream deadline', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'simple-gpt-mcp-processes-'));
  const upstream = await upstreamFixture();
  const one = await connect(dir, upstream.baseURL);
  const two = await connect(dir, upstream.baseURL);
  t.after(async () => {
    await one.close();
    await two.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  });
  const first = await one.call('chat', { message: 'first' });
  const request_id = randomUUID();
  const slow = one.call('chat', {
    message: '[stall]',
    session_id: first.data.session_id,
    request_id,
    timeout_ms: 1000,
  });
  while (upstream.posts.length < 2)
    await new Promise((resolve) => setTimeout(resolve, 5));
  const blocked = await two.call('chat', {
    message: 'overlap',
    session_id: first.data.session_id,
  });
  assert.equal((blocked.data.error as { code: string }).code, 'SESSION_BUSY');
  const interrupted = await slow;
  assert.equal(interrupted.data.status, 'recovery_required');
  assert.equal(
    (interrupted.data.error as { code: string }).code,
    'DEADLINE_EXCEEDED',
  );
  assert.equal(upstream.posts.length, 2);
  const recovered = await two.call('request_status', {
    request_id,
    action: 'recover',
  });
  assert.equal(recovered.data.status, 'completed');
});

test('legacy 2025 MCP initialize/list/call is served over stdio', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'simple-gpt-mcp-legacy-'));
  const child = spawn(process.execPath, [resolve('dist/index.js')], {
    env: {
      PATH: process.env.PATH,
      OPENAI_API_KEY: 'synthetic-key',
      SIMPLE_GPT_MCP_DATA_DIR: dir,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(async () => {
    child.kill();
    await rm(dir, { recursive: true, force: true });
  });
  let buffer = '';
  let stderr = '';
  const results = new Map<number, (result: Record<string, unknown>) => void>();
  child.stderr.on('data', (data) => {
    stderr += String(data);
  });
  child.stdout.on('data', (data) => {
    buffer += String(data);
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const value = JSON.parse(line) as {
        id: number;
        result: Record<string, unknown>;
      };
      results.get(value.id)?.(value.result);
    }
  });
  const send = (id: number, method: string, params: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Legacy MCP timed out: ${stderr}`)),
        5000,
      );
      results.set(id, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`,
      );
    });
  const init = await send(1, 'initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'legacy-test', version: '1' },
  });
  assert.equal(init.protocolVersion, '2025-11-25');
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
  );
  const tools = await send(2, 'tools/list', {});
  assert.equal((tools.tools as unknown[]).length, 3);
  const list = await send(3, 'tools/call', {
    name: 'sessions',
    arguments: { operation: 'list' },
  });
  assert.deepEqual(
    (list.structuredContent as { sessions: unknown[] }).sessions,
    [],
  );
  child.stdin.end();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Server did not exit after EOF')),
      5000,
    );
    child.once('exit', (code) => {
      clearTimeout(timer);
      assert.equal(code, 0);
      resolve();
    });
  });
});
