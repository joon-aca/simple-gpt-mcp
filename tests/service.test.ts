import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { stat, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { ChatService } from '../src/chat-service.js';
import { AppError } from '../src/errors.js';
import { UpstreamError } from '../src/openai-adapter.js';
import { deferred, fixture, outcome, FakeAdapter } from './helpers.js';

test('new and continued sessions persist defaults, instructions, pointers, and overrides', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const first = await f.service.chat({
    message: 'hello',
    instructions: 'Remember this instruction',
    model: 'original-model',
    verbosity: 'low',
  });
  const id = String(first.session_id);
  await f.service.chat({
    session_id: id,
    message: 'follow up',
    model: 'override-model',
    instructions: '',
  });
  await f.service.chat({ session_id: id, message: 'again' });
  assert.equal(f.adapter.calls[1]?.defaults.model, 'override-model');
  assert.equal(f.adapter.calls[1]?.defaults.instructions, '');
  assert.equal(f.adapter.calls[2]?.defaults.model, 'original-model');
  assert.equal(
    f.adapter.calls[2]?.defaults.instructions,
    'Remember this instruction',
  );
  assert.equal(f.adapter.calls[1]?.previousResponseId, first.response_id);
  f.service.sessions({
    operation: 'configure',
    session_id: id,
    instructions: 'New default',
    model: 'configured-model',
  });
  await f.service.chat({ session_id: id, message: 'configured' });
  assert.equal(f.adapter.calls[3]?.defaults.instructions, 'New default');
  assert.equal(f.adapter.calls[3]?.defaults.model, 'configured-model');
  const secondStore = new Store(f.config);
  const secondAdapter = new FakeAdapter();
  const second = new ChatService(secondStore, secondAdapter, f.config);
  const previous = f.store.getSession(id).responseId;
  try {
    await second.chat({ session_id: id, message: 'from another instance' });
    assert.equal(secondAdapter.calls[0]?.previousResponseId, previous);
  } finally {
    await second.close();
  }
});

test('replay returns cached result without creating another session or upstream request', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const request_id = randomUUID();
  const args = { message: 'one', request_id };
  const first = await f.service.chat(args);
  const replay = await f.service.chat(args);
  assert.equal(replay.response_id, first.response_id);
  assert.equal('cached' in replay && replay.cached, true);
  assert.equal(f.adapter.calls.length, 1);
  await assert.rejects(
    f.service.chat({ ...args, message: 'different' }),
    (e: unknown) => e instanceof AppError && e.code === 'REQUEST_ID_CONFLICT',
  );
  assert.equal(
    (f.service.sessions({ operation: 'list' }).sessions as unknown[]).length,
    1,
  );
});

test('invalid input, unknown options, UUID traversal and missing model do not touch upstream', async (t) => {
  const f = await fixture({ model: undefined });
  t.after(f.close);
  for (const args of [
    { message: '' },
    { message: '   ' },
    { message: 'x', code_interpreter: true },
    { message: 'x', session_id: '../outside' },
    { message: 'x', max_output_tokens: 100000 },
  ])
    await assert.rejects(f.service.chat(args));
  await assert.rejects(
    f.service.chat({ message: 'x' }),
    (e: unknown) => e instanceof AppError && e.code === 'MODEL_REQUIRED',
  );
  assert.equal(f.adapter.calls.length, 0);
  assert.deepEqual(f.service.sessions({ operation: 'list' }).sessions, []);
});

test('session metadata excludes content and deleting local state does not claim upstream deletion', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const reply = await f.service.chat({
    message: 'PRIVATE_PROMPT',
    instructions: 'PRIVATE_INSTRUCTIONS',
  });
  const metadata = JSON.stringify(
    f.service.sessions({ operation: 'get', session_id: reply.session_id }),
  );
  assert(!metadata.includes('PRIVATE_'));
  assert(!metadata.includes('A useful answer'));
  assert.equal((await stat(join(f.dir, 'state.sqlite'))).mode & 0o777, 0o600);
  assert.equal((await stat(f.dir)).mode & 0o777, 0o700);
  const database = await readFile(join(f.dir, 'state.sqlite'));
  assert(!database.includes(Buffer.from('PRIVATE_PROMPT')));
  assert(!database.includes(Buffer.from('synthetic-key')));
  const deleted = f.service.sessions({
    operation: 'delete',
    session_id: reply.session_id,
  });
  assert.equal(deleted.remote_data_deleted, false);
  assert.throws(
    () => f.store.getRequest(String(reply.request_id)),
    (e: unknown) => e instanceof AppError && e.code === 'REQUEST_NOT_FOUND',
  );
});

test('separate SQLite connections cannot overwrite an active session', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const initial = await f.service.chat({ message: 'initial' });
  const gate = deferred<ReturnType<typeof outcome>>();
  const entered = deferred<void>();
  f.adapter.handler = async (context) => {
    context.onResponseId('resp_waiting');
    entered.resolve();
    return gate.promise;
  };
  const running = f.service.chat({
    session_id: initial.session_id,
    message: 'A',
  });
  await entered.promise;
  const other = new ChatService(
    new Store(f.config),
    new FakeAdapter(),
    f.config,
  );
  try {
    await assert.rejects(
      other.chat({ session_id: initial.session_id, message: 'B' }),
      (e: unknown) => e instanceof AppError && e.code === 'SESSION_BUSY',
    );
    assert.throws(
      () =>
        other.sessions({ operation: 'delete', session_id: initial.session_id }),
      (e: unknown) => e instanceof AppError && e.code === 'SESSION_BUSY',
    );
    gate.resolve(outcome({ responseId: 'resp_waiting' }));
    await running;
    assert.equal(
      f.store.getSession(String(initial.session_id)).responseId,
      'resp_waiting',
    );
  } finally {
    gate.resolve(outcome());
    await other.close();
  }
});

test('disconnect keeps the response ID and blocks continuation until recovery', async (t) => {
  const f = await fixture();
  t.after(f.close);
  f.adapter.handler = async (c) => {
    c.onResponseId('resp_lost');
    throw new UpstreamError('STREAM_INTERRUPTED', 'Stream interrupted', false);
  };
  const interrupted = await f.service.chat({ message: 'work' });
  assert.equal(interrupted.status, 'recovery_required');
  assert.equal(interrupted.response_id, 'resp_lost');
  assert.equal(
    f.store.getSession(String(interrupted.session_id)).responseId,
    undefined,
  );
  await assert.rejects(
    f.service.chat({ session_id: interrupted.session_id, message: 'next' }),
    (e: unknown) => e instanceof AppError && e.code === 'SESSION_BLOCKED',
  );
  f.adapter.handler = async () => outcome({ responseId: 'resp_lost' });
  const recovered = await f.service.requestStatus({
    request_id: interrupted.request_id,
    action: 'recover',
  });
  assert.equal(recovered.status, 'completed');
  assert.deepEqual(f.adapter.retrieves, ['resp_lost']);
  assert.equal(f.adapter.calls.length, 1);
  assert.equal(
    f.store.getSession(String(interrupted.session_id)).responseId,
    'resp_lost',
  );
});

test('unknown outcome is never retried and explicit abandonment unblocks the session', async (t) => {
  const f = await fixture();
  t.after(f.close);
  f.adapter.handler = async () => {
    throw new UpstreamError('CONNECTION', 'Uncertain', false);
  };
  const request_id = randomUUID();
  const input = { message: 'one', request_id };
  const first = await f.service.chat(input);
  assert.equal(first.status, 'unknown_outcome');
  await f.service.chat(input);
  assert.equal(f.adapter.calls.length, 1);
  await assert.rejects(
    f.service.requestStatus({ request_id, action: 'recover' }),
    (e: unknown) => e instanceof AppError && e.code === 'UNKNOWN_OUTCOME',
  );
  await f.service.requestStatus({ request_id, action: 'abandon' });
  f.adapter.handler = async () => outcome();
  assert.equal(
    (
      await f.service.chat({
        session_id: first.session_id,
        message: 'after abandonment',
      })
    ).status,
    'completed',
  );
});

test('definitive rejection, incomplete response, and refusal have explicit outcomes', async (t) => {
  const f = await fixture();
  t.after(f.close);
  f.adapter.handler = async () => {
    throw new UpstreamError(
      'UPSTREAM_AUTH_ERROR',
      'Authentication rejected',
      true,
    );
  };
  const failed = await f.service.chat({ message: 'one' });
  assert.equal(failed.status, 'failed');
  f.adapter.handler = async () =>
    outcome({
      state: 'incomplete',
      message: 'partial',
      incompleteReason: 'max_output_tokens',
    });
  const partial = await f.service.chat({ message: 'two' });
  assert.equal(partial.status, 'incomplete');
  assert.equal(
    f.store.getSession(String(partial.session_id)).responseId,
    undefined,
  );
  f.adapter.handler = async () =>
    outcome({ state: 'refused', message: '', refusal: 'Cannot do that' });
  const refusal = await f.service.chat({ message: 'three' });
  assert.equal(refusal.status, 'refused');
  assert.equal(refusal.refusal, 'Cannot do that');
});

test('deadline and cancellation cover the stream and retain recovery identifiers', async (t) => {
  const f = await fixture({ defaultTimeoutMs: 20 });
  t.after(f.close);
  f.adapter.handler = async (c) => {
    c.onResponseId('resp_slow');
    return new Promise(() => {});
  };
  const timed = await f.service.chat({ message: 'slow' });
  assert.equal(timed.status, 'recovery_required');
  assert.equal((timed.error as { code: string }).code, 'DEADLINE_EXCEEDED');
  const controller = new AbortController();
  const started = deferred<void>();
  f.adapter.handler = async () => {
    started.resolve();
    return new Promise(() => {});
  };
  const work = f.service.chat({ message: 'cancel' }, controller.signal);
  await started.promise;
  controller.abort();
  const cancelled = await work;
  assert.equal(cancelled.status, 'unknown_outcome');
  assert.equal((cancelled.error as { code: string }).code, 'CANCELLED');
});

test('stale worker cannot commit after another owner recovers its request', async (t) => {
  const f = await fixture();
  t.after(f.close);
  let now = Date.now();
  const store = new Store(f.config, () => now);
  try {
    const reservation = store.reserve({
      message: 'x',
      request_id: randomUUID(),
    });
    const old = reservation.request;
    store.captureResponse(old.id, old.owner!, 'resp_stale');
    now += f.config.defaultTimeoutMs + 31_000;
    assert.equal(store.inspect(old.id).state, 'recovery_required');
    const fresh = store.claimRecovery(old.id);
    assert.notEqual(fresh.owner, old.owner);
    const result = {
      request_id: old.id,
      session_id: old.sessionId,
      response_id: 'resp_stale',
      model: 'test-model',
      status: 'completed' as const,
      message: 'recovered',
      usage: null,
      options: {
        max_output_tokens: 8192,
        timeout_ms: 120000,
        instructions_set: false,
      },
    };
    assert.throws(
      () => store.finish(old.id, old.owner!, result),
      (e: unknown) => e instanceof AppError && e.code === 'STALE_REQUEST',
    );
    store.finish(fresh.id, fresh.owner!, result);
    assert.equal(store.getSession(old.sessionId).responseId, 'resp_stale');
  } finally {
    store.close();
  }
});

test('expired result in an active session is pruned but its request ID remains a replay tombstone', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const request_id = randomUUID();
  const args = { message: 'one', request_id };
  await f.service.chat(args);
  // Age only the request; its session stays recently active and is retained.
  const db = new DatabaseSync(join(f.dir, 'state.sqlite'));
  db.prepare('UPDATE requests SET updated_at=0 WHERE id=?').run(request_id);
  db.close();
  f.store.prune();
  assert.equal(f.store.getRequest(request_id).result, undefined);
  assert.equal(f.store.getRequest(request_id).usage?.total_tokens, 19);
  const replay = await f.service.chat(args);
  assert.equal('result_pruned' in replay && replay.result_pruned, true);
  assert.equal(replay.status, 'result_pruned');
  assert.equal((replay.usage as { total_tokens: number }).total_tokens, 19);
  assert.equal(f.adapter.calls.length, 1);
});

test('idle sessions expire after retention so one-shot use cannot exhaust row limits', async (t) => {
  const f = await fixture({ maxSessions: 2 });
  t.after(f.close);
  const idle = await f.service.chat({ message: 'one-shot' });
  f.adapter.handler = async () => {
    throw new UpstreamError('CONNECTION', 'Uncertain', false);
  };
  const unresolved = await f.service.chat({ message: 'uncertain' });
  assert.equal(unresolved.status, 'unknown_outcome');
  f.adapter.handler = async () => outcome();
  await assert.rejects(
    f.service.chat({ message: 'full' }),
    (e: unknown) => e instanceof AppError && e.code === 'STORAGE_LIMIT',
  );
  const later = new Store(f.config, () => Date.now() + 31 * 86_400_000);
  try {
    assert.throws(
      () => later.getSession(String(idle.session_id)),
      (e: unknown) => e instanceof AppError && e.code === 'SESSION_NOT_FOUND',
    );
    assert.throws(
      () => later.getRequest(String(idle.request_id)),
      (e: unknown) => e instanceof AppError && e.code === 'REQUEST_NOT_FOUND',
    );
    // Unresolved work waits for an explicit recover or abandon decision.
    assert.equal(
      later.getSession(String(unresolved.session_id)).activeRequestId,
      unresolved.request_id,
    );
  } finally {
    later.close();
  }
  assert.equal(
    (await f.service.chat({ message: 'room again' })).status,
    'completed',
  );
});

test('limits reject excess input and concurrency before upstream calls', async (t) => {
  const f = await fixture({ maxInputBytes: 10, maxConcurrent: 1 });
  t.after(f.close);
  await assert.rejects(
    f.service.chat({ message: '12345678901' }),
    (e: unknown) => e instanceof AppError && e.code === 'INPUT_TOO_LARGE',
  );
  const gate = deferred<ReturnType<typeof outcome>>();
  const entered = deferred<void>();
  f.adapter.handler = async () => {
    entered.resolve();
    return gate.promise;
  };
  const work = f.service.chat({ message: 'one' });
  await entered.promise;
  await assert.rejects(
    f.service.chat({ message: 'two' }),
    (e: unknown) => e instanceof AppError && e.code === 'SERVER_BUSY',
  );
  gate.resolve(outcome());
  await work;
});

test('database write failure cannot produce a successful result', async (t) => {
  const f = await fixture();
  t.after(async () => {
    await f.service.close().catch(() => {});
    await rm(f.dir, { recursive: true, force: true });
  });
  f.adapter.handler = async () => {
    f.store.close();
    return outcome();
  };
  await assert.rejects(f.service.chat({ message: 'write failure' }));
});

test('oversized results retain known usage and remote identity without persisting content', async (t) => {
  const f = await fixture({ maxResultBytes: 1024 });
  t.after(f.close);
  f.adapter.handler = async (c) => {
    c.onResponseId('resp_big');
    return outcome({ responseId: 'resp_big', message: 'x'.repeat(2000) });
  };
  const reply = await f.service.chat({ message: 'x' });
  assert.equal(reply.status, 'recovery_required');
  assert.equal(reply.message, '');
  assert.equal((reply.usage as { total_tokens: number }).total_tokens, 19);
  assert.equal(
    f.store.getRequest(String(reply.request_id)).responseId,
    'resp_big',
  );
});

test('storage capacity failure retains known usage and can recover after capacity is restored', async (t) => {
  const f = await fixture();
  t.after(f.close);
  f.adapter.handler = async (c) => {
    c.onResponseId('resp_storage');
    f.config.maxStoredBytes = 100;
    return outcome({ responseId: 'resp_storage' });
  };
  const reply = await f.service.chat({ message: 'x' });
  assert.equal(reply.status, 'recovery_required');
  assert.equal((reply.usage as { total_tokens: number }).total_tokens, 19);
  assert.equal((reply.error as { code: string }).code, 'STORAGE_LIMIT');
  f.config.maxStoredBytes = 100000;
  f.adapter.handler = async () => outcome({ responseId: 'resp_storage' });
  assert.equal(
    (
      await f.service.requestStatus({
        request_id: reply.request_id,
        action: 'recover',
      })
    ).status,
    'completed',
  );
});

test('session and request row limits fail without an upstream call', async (t) => {
  const f = await fixture({ maxSessions: 1 });
  t.after(f.close);
  const first = await f.service.chat({ message: 'x' });
  await assert.rejects(
    f.service.chat({ message: 'y' }),
    (e: unknown) => e instanceof AppError && e.code === 'STORAGE_LIMIT',
  );
  f.config.maxRequests = 1;
  await assert.rejects(
    f.service.chat({ session_id: first.session_id, message: 'z' }),
    (e: unknown) => e instanceof AppError && e.code === 'STORAGE_LIMIT',
  );
  assert.equal(f.adapter.calls.length, 1);
});
