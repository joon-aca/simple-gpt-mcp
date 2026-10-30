import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { loadConfig } from '../src/config.js';
import { AppError } from '../src/errors.js';
import { fixture } from './helpers.js';
import { randomUUID } from 'node:crypto';

test('state initialization rejects symlink directories and database files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'simple-gpt-mcp-path-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const real = join(root, 'real');
  await mkdir(real);
  const link = join(root, 'link');
  await symlink(real, link);
  const config = loadConfig({
    OPENAI_API_KEY: 'dummy',
    SIMPLE_GPT_MCP_DATA_DIR: link,
  });
  assert.throws(
    () => new Store(config),
    (e: unknown) => e instanceof AppError && e.code === 'UNSAFE_STATE_PATH',
  );
  await writeFile(join(root, 'sentinel'), 'do not change');
  await symlink(join(root, 'sentinel'), join(real, 'state.sqlite'));
  assert.throws(
    () => new Store({ ...config, dataDir: real }),
    (e: unknown) => e instanceof AppError && e.code === 'UNSAFE_STATE_PATH',
  );
});

test('future database versions fail fast rather than modifying the schema', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'simple-gpt-mcp-version-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const db = new DatabaseSync(join(root, 'state.sqlite'));
  db.exec('PRAGMA user_version=99');
  db.close();
  const config = loadConfig({
    OPENAI_API_KEY: 'dummy',
    SIMPLE_GPT_MCP_DATA_DIR: root,
  });
  assert.throws(
    () => new Store(config),
    (e: unknown) => e instanceof AppError && e.code === 'SCHEMA_TOO_NEW',
  );
});

test('v1 databases migrate usage independently before expired content is pruned', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'simple-gpt-mcp-migrate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const db = new DatabaseSync(join(root, 'state.sqlite'));
  db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY,defaults_json TEXT NOT NULL,response_id TEXT,active_request_id TEXT,revision INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE requests(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,digest TEXT NOT NULL,state TEXT NOT NULL,response_id TEXT,owner TEXT,lease_until INTEGER,result_json TEXT,options_json TEXT NOT NULL,base_revision INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    PRAGMA user_version=1;`);
  const session = randomUUID();
  const request = randomUUID();
  // The session is recent; only its request is old enough for content pruning.
  db.prepare(
    'INSERT INTO sessions(id,defaults_json,created_at,updated_at) VALUES(?,?,?,?)',
  ).run(
    session,
    JSON.stringify({
      model: 'test-model',
      instructions: '',
      max_output_tokens: 8192,
      timeout_ms: 120000,
    }),
    Date.now(),
    Date.now(),
  );
  db.prepare(
    "INSERT INTO requests(id,session_id,digest,state,result_json,options_json,base_revision,created_at,updated_at) VALUES(?,?,?,'completed',?,?,0,0,0)",
  ).run(
    request,
    session,
    'digest',
    JSON.stringify({
      message: 'old result',
      usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
    }),
    '{}',
  );
  db.close();
  const store = new Store(
    loadConfig({ OPENAI_API_KEY: 'dummy', SIMPLE_GPT_MCP_DATA_DIR: root }),
  );
  try {
    assert.equal(store.getRequest(request).result, undefined);
    assert.equal(store.getRequest(request).usage?.total_tokens, 3);
  } finally {
    store.close();
  }
});

test('session pagination, missing IDs and configuration changes have explicit behavior', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const one = await f.service.chat({ message: 'one' });
  const two = await f.service.chat({ message: 'two' });
  const first = f.service.sessions({ operation: 'list', limit: 1 });
  assert.equal((first.sessions as unknown[]).length, 1);
  assert(first.next_cursor);
  const second = f.service.sessions({
    operation: 'list',
    limit: 1,
    after: first.next_cursor,
  });
  assert.equal((second.sessions as unknown[]).length, 1);
  assert.equal(second.next_cursor, null);
  const ids = new Set(
    [
      ...(first.sessions as { session_id: string }[]),
      ...(second.sessions as { session_id: string }[]),
    ].map((s) => s.session_id),
  );
  assert.deepEqual(ids, new Set([one.session_id, two.session_id]));
  assert.throws(
    () => f.store.getSession('missing'),
    (e: unknown) => e instanceof AppError && e.code === 'SESSION_NOT_FOUND',
  );
  assert.throws(
    () => f.store.getRequest('missing'),
    (e: unknown) => e instanceof AppError && e.code === 'REQUEST_NOT_FOUND',
  );
  f.config.maxInputBytes = 4;
  assert.throws(
    () =>
      f.service.sessions({
        operation: 'configure',
        session_id: one.session_id,
        instructions: 'too long',
      }),
    (e: unknown) => e instanceof AppError && e.code === 'INPUT_TOO_LARGE',
  );
});
