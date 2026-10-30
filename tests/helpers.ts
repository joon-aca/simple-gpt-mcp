import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Config } from '../src/config.js';
import { loadConfig } from '../src/config.js';
import { ChatService } from '../src/chat-service.js';
import { Store } from '../src/store.js';
import type {
  AdapterContext,
  Outcome,
  UpstreamAdapter,
} from '../src/openai-adapter.js';

export function outcome(overrides: Partial<Outcome> = {}): Outcome {
  return {
    responseId: `resp_${randomUUID()}`,
    model: 'test-model',
    state: 'completed',
    message: 'A useful answer',
    usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19 },
    ...overrides,
  };
}

export class FakeAdapter implements UpstreamAdapter {
  calls: Array<{
    message: string;
    defaults: Parameters<UpstreamAdapter['create']>[0]['defaults'];
    previousResponseId?: string;
  }> = [];
  retrieves: string[] = [];
  handler: (context: AdapterContext) => Promise<Outcome> = async (context) => {
    const result = outcome();
    context.onResponseId(result.responseId);
    return result;
  };
  async create(
    input: Parameters<UpstreamAdapter['create']>[0],
    context: AdapterContext,
  ) {
    this.calls.push(input);
    return this.handler(context);
  }
  async retrieve(id: string, context: AdapterContext) {
    this.retrieves.push(id);
    return this.handler(context);
  }
}

export async function fixture(overrides: Partial<Config> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'simple-gpt-mcp-test-'));
  const config = {
    ...loadConfig({
      OPENAI_API_KEY: 'synthetic-key',
      OPENAI_MODEL: 'test-model',
      SIMPLE_GPT_MCP_DATA_DIR: dir,
    }),
    ...overrides,
  };
  const adapter = new FakeAdapter();
  const store = new Store(config);
  const service = new ChatService(store, adapter, config);
  return {
    dir,
    config,
    adapter,
    store,
    service,
    close: async () => {
      await service.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
