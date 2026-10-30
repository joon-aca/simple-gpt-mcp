import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Response } from 'openai/resources/responses/responses';
import { loadConfig } from '../src/config.js';
import { AppError, safeError } from '../src/errors.js';
import {
  OpenAIAdapter,
  normalizeResponse,
  ResponseLimitError,
  UpstreamError,
} from '../src/openai-adapter.js';
import { upstreamFixture, apiResponse } from './upstream-fixture.js';
import { fixture } from './helpers.js';

test('configuration validates secrets, limits, absolute paths and trusted upstream URLs', () => {
  assert.throws(() => loadConfig({}), /OPENAI_API_KEY/);
  const env = {
    OPENAI_API_KEY: 'dummy',
    SIMPLE_GPT_MCP_DATA_DIR: '/tmp/simple-gpt-mcp-config',
  };
  for (const override of [
    { SIMPLE_GPT_MCP_DATA_DIR: 'relative/path' },
    { SIMPLE_GPT_MCP_TIMEOUT_MS: '0' },
    { SIMPLE_GPT_MCP_MAX_CONCURRENT: 'NaN' },
    { OPENAI_BASE_URL: 'not a URL' },
    { OPENAI_BASE_URL: 'http://remote.example/v1' },
    { OPENAI_BASE_URL: 'https://user:pass@example.com/v1' },
    { OPENAI_BASE_URL: 'https://example.com/v1?key=private' },
  ])
    assert.throws(() => loadConfig({ ...env, ...override }));
  assert.equal(
    loadConfig({ ...env, OPENAI_BASE_URL: 'http://127.0.0.1:1234/v1' }).baseURL,
    'http://127.0.0.1:1234/v1',
  );
  assert.equal(
    loadConfig({
      ...env,
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_MODEL: ' custom-model ',
    }).model,
    'custom-model',
  );
});

test('response normalization includes all message text, refusal, usage, and nonterminal status', () => {
  const response = apiResponse();
  response.output.push({
    ...response.output[0]!,
    id: 'msg_second',
    content: [{ type: 'output_text', text: 'second message', annotations: [] }],
  });
  assert.equal(
    normalizeResponse(response as unknown as Response, 262144).message,
    'fixture answer\nsecond message',
  );
  assert.equal(
    normalizeResponse(
      apiResponse('resp_empty', 'completed', '') as unknown as Response,
      262144,
    ).state,
    'incomplete',
  );
  assert.equal(
    normalizeResponse(
      apiResponse('resp_pending', 'in_progress', '') as unknown as Response,
      262144,
    ).state,
    'recovery_required',
  );
  assert.equal(
    normalizeResponse(
      apiResponse('resp_cancelled', 'cancelled', '') as unknown as Response,
      262144,
    ).state,
    'failed',
  );
  assert.throws(
    () =>
      normalizeResponse(
        apiResponse(
          'resp_huge',
          'completed',
          'x'.repeat(2000),
        ) as unknown as Response,
        1024,
      ),
    (error: unknown) =>
      error instanceof ResponseLimitError && error.usage?.total_tokens === 19,
  );
});

test('real SDK errors are sanitized; accepted stream failures retain recorded response IDs', async (t) => {
  const f = await fixture();
  const upstream = await upstreamFixture();
  t.after(async () => {
    await upstream.close();
    await f.close();
  });
  const adapter = new OpenAIAdapter({ ...f.config, baseURL: upstream.baseURL });
  const defaults = {
    model: 'test-model',
    instructions: '',
    max_output_tokens: 8192,
    timeout_ms: 120000,
  };
  const ids: string[] = [];
  const context = {
    signal: new AbortController().signal,
    onResponseId: (id: string) => ids.push(id),
  };
  await assert.rejects(
    adapter.create({ message: '[reject]', defaults }, context),
    (error: unknown) =>
      error instanceof UpstreamError &&
      error.definitive &&
      !error.message.includes('PRIVATE_'),
  );
  assert.deepEqual(ids, []);
  await assert.rejects(
    adapter.create({ message: '[unknown]', defaults }, context),
    (error: unknown) => error instanceof UpstreamError && !error.definitive,
  );
  assert.deepEqual(ids, []);
  await assert.rejects(
    adapter.create({ message: '[drop]', defaults }, context),
  );
  assert.equal(ids.length, 1);
  const id = ids[0]!;
  upstream.responses.set(id, apiResponse(id, 'in_progress', ''));
  assert.equal(
    (await adapter.retrieve(id, context)).state,
    'recovery_required',
  );
  upstream.responses.set(id, apiResponse('resp_different'));
  await assert.rejects(
    adapter.retrieve(id, context),
    (error: unknown) =>
      error instanceof UpstreamError && error.code === 'RESPONSE_ID_MISMATCH',
  );
  await assert.rejects(
    adapter.retrieve('resp_missing', context),
    (error: unknown) =>
      error instanceof UpstreamError && error.code === 'UPSTREAM_NOT_FOUND',
  );
  assert.equal(upstream.posts.length, 3);
});

async function adapterFixture(t: { after: (fn: () => Promise<void>) => void }) {
  // A 1 KiB result limit gives an 8 KiB per-event/body limit.
  const f = await fixture({ maxResultBytes: 1024 });
  const upstream = await upstreamFixture();
  t.after(async () => {
    await upstream.close();
    await f.close();
  });
  const adapter = new OpenAIAdapter({ ...f.config, baseURL: upstream.baseURL });
  const ids: string[] = [];
  const context = {
    signal: new AbortController().signal,
    onResponseId: (id: string) => ids.push(id),
  };
  const defaults = {
    model: 'test-model',
    instructions: '',
    max_output_tokens: 8192,
    timeout_ms: 120000,
  };
  return { upstream, adapter, ids, context, defaults };
}

const isCode = (code: string, definitive?: boolean) => (error: unknown) =>
  error instanceof AppError &&
  error.code === code &&
  (definitive === undefined ||
    (error instanceof UpstreamError && error.definitive === definitive));

test('byte limit applies per stream event, not to the token-by-token stream total', async (t) => {
  const { adapter, ids, context, defaults } = await adapterFixture(t);
  // 2000 realistic delta events total far more than the 8 KiB limit.
  const long = await adapter.create({ message: '[long]', defaults }, context);
  assert.equal(long.state, 'completed');
  await assert.rejects(
    adapter.create({ message: '[huge]', defaults }, context),
    isCode('STREAM_LIMIT'),
  );
  // The oversized event arrived after response.created, so recovery remains possible.
  assert.equal(ids.length, 2);
});

test('byte limit bounds a whole JSON body', async (t) => {
  const { upstream, adapter, context } = await adapterFixture(t);
  upstream.responses.set(
    'resp_big',
    apiResponse('resp_big', 'completed', 'x'.repeat(10_000)),
  );
  await assert.rejects(
    adapter.retrieve('resp_big', context),
    isCode('STREAM_LIMIT'),
  );
});

test('a failed retrieval keeps the recorded response recoverable unless it is gone', async (t) => {
  const { upstream, adapter, ids, context, defaults } = await adapterFixture(t);
  await adapter.create({ message: 'hello', defaults }, context);
  const id = ids[0]!;
  for (const [status, code] of [
    [429, 'UPSTREAM_RATE_LIMIT'],
    [401, 'UPSTREAM_AUTH_ERROR'],
    [403, 'UPSTREAM_AUTH_ERROR'],
    [500, 'UPSTREAM_ERROR'],
  ] as const) {
    upstream.control.getStatus = status;
    await assert.rejects(adapter.retrieve(id, context), isCode(code, false));
  }
  upstream.control.getStatus = undefined;
  assert.equal((await adapter.retrieve(id, context)).state, 'completed');
  await assert.rejects(
    adapter.retrieve('resp_expired', context),
    isCode('UPSTREAM_NOT_FOUND', true),
  );
});

test('rejected requests name the upstream code and parameter without echoing content', async (t) => {
  const { adapter, context, defaults } = await adapterFixture(t);
  await assert.rejects(
    adapter.create({ message: '[reject]', defaults }, context),
    (error: unknown) => {
      assert(error instanceof UpstreamError && error.definitive);
      assert.deepEqual(error.details, {
        upstream_request_id: 'req_rejected',
        upstream_code: 'unsupported_parameter',
        upstream_param: 'reasoning.effort',
      });
      assert.match(error.message, /unsupported_parameter: reasoning\.effort/);
      assert(!error.message.includes('PRIVATE_'));
      return true;
    },
  );
});

test('internal errors log their class and codes, never their message', (t) => {
  const lines: string[] = [];
  t.mock.method(process.stderr, 'write', (line: string) => lines.push(line));
  const sqlite = Object.assign(new Error('PRIVATE /secret/path'), {
    code: 'ERR_SQLITE_ERROR',
    errstr: 'database is locked',
  });
  assert.equal(safeError(sqlite).code, 'INTERNAL_ERROR');
  safeError('PRIVATE thrown string');
  const events = lines.map(
    (line) => JSON.parse(line) as Record<string, unknown>,
  );
  assert.equal(events[0]?.event, 'internal_error');
  assert.equal(events[0]?.error_name, 'Error');
  assert.equal(events[0]?.error_code, 'ERR_SQLITE_ERROR');
  assert.equal(events[0]?.sqlite_error, 'database is locked');
  assert.equal(events[1]?.error_name, 'string');
  assert(!lines.join('').includes('PRIVATE'));
});
