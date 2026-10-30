import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createServer } from '../src/server.js';
import { deferred, fixture, outcome } from './helpers.js';

test('tool factory advertises validated schemas and maps application errors to structured results', async (t) => {
  const f = await fixture();
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const handle = serveStdio(() => createServer(f.service), {
    transport: serverTransport,
  });
  const client = new Client(
    { name: 'in-memory-test', version: '1' },
    { capabilities: {} },
  );
  t.after(async () => {
    await client.close();
    await handle.close();
    await f.close();
  });
  await client.connect(clientTransport);
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 3);
  const sessions = tools.tools.find((t) => t.name === 'sessions');
  assert.equal(sessions?.annotations?.destructiveHint, true);
  for (const [name, args] of [
    ['chat', { message: 'x', session_id: randomUUID() }],
    ['sessions', { operation: 'get', session_id: randomUUID() }],
    ['request_status', { request_id: randomUUID() }],
  ] as const) {
    const reply = await client.callTool({ name, arguments: args });
    assert.equal(reply.isError, true);
    assert.equal(
      (reply.structuredContent as Record<string, unknown>).status,
      'error',
    );
  }
  const first = await client.callTool({
    name: 'chat',
    arguments: { message: 'hello' },
  });
  assert.equal(first.isError, false);
  const status = await client.callTool({
    name: 'request_status',
    arguments: {
      request_id: (first.structuredContent as Record<string, unknown>)
        .request_id,
    },
  });
  assert.equal(
    (status.structuredContent as Record<string, unknown>).status,
    'completed',
  );
  const list = await client.callTool({
    name: 'sessions',
    arguments: { operation: 'list' },
  });
  assert.equal(list.isError, false);
  // Replaying an in-flight request reports its state without an answer, so it is not a success.
  const gate = deferred<ReturnType<typeof outcome>>();
  const entered = deferred<void>();
  f.adapter.handler = async () => {
    entered.resolve();
    return gate.promise;
  };
  const args = { message: 'slow', request_id: randomUUID() };
  const running = client.callTool({ name: 'chat', arguments: args });
  await entered.promise;
  const replay = await client.callTool({ name: 'chat', arguments: args });
  assert.equal(
    (replay.structuredContent as Record<string, unknown>).status,
    'running',
  );
  assert.equal(replay.isError, true);
  const inspect = await client.callTool({
    name: 'request_status',
    arguments: { request_id: args.request_id },
  });
  assert.equal(inspect.isError, false);
  gate.resolve(outcome());
  assert.equal((await running).isError, false);
});
