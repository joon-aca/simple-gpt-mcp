#!/usr/bin/env node
import {
  serveStdio,
  StdioServerTransport,
} from '@modelcontextprotocol/server/stdio';
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { OpenAIAdapter } from './openai-adapter.js';
import { ChatService } from './chat-service.js';
import { createServer } from './server.js';
import { log } from './logging.js';
import { safeError } from './errors.js';

try {
  const config = loadConfig();
  const service = new ChatService(
    new Store(config),
    new OpenAIAdapter(config),
    config,
  );
  const transport = new StdioServerTransport(process.stdin, process.stdout, {
    maxBufferSize: 2_097_152,
  });
  const handle = serveStdio(() => createServer(service), {
    transport,
    onerror: () => log('protocol_error'),
  });
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await handle.close();
    await service.close();
  };
  for (const event of ['SIGINT', 'SIGTERM'] as const)
    process.once(event, () => {
      void close().catch(() => {
        process.exitCode = 1;
      });
    });
  process.stdin.once('end', () => {
    void close().catch(() => {
      process.exitCode = 1;
    });
  });
  log('server_started');
} catch (error) {
  const safe = safeError(error);
  log('startup_failed', { code: safe.code });
  process.stderr.write(`${safe.message}\n`);
  process.exitCode = 1;
}
