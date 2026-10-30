import { McpServer } from '@modelcontextprotocol/server';
import { ChatService, toolFailure } from './chat-service.js';
import {
  chatSchema,
  outputSchema,
  requestSchema,
  sessionsSchema,
} from './schemas.js';

export function createServer(service: ChatService) {
  const server = new McpServer(
    { name: 'simple-gpt-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );
  // Each tool lists the statuses that mean success; anything else, including unknown statuses, is an error.
  const result = (data: Record<string, unknown>, ok: readonly string[]) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
    isError: !ok.includes(String(data.status)),
  });
  // A chat call succeeds only with an answer; replaying an in-flight or abandoned request has none.
  const chatOk = ['completed'];
  const sessionsOk = ['ok', 'configured', 'deleted'];
  const requestOk = ['completed', 'running', 'abandoned'];
  server.registerTool(
    'chat',
    {
      description:
        'Ask an OpenAI model or continue a persistent session. Explicit per-call overrides; no local code or file access. Save request_id for interruption recovery.',
      inputSchema: chatSchema,
      outputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (input, context) => {
      try {
        return result(
          { ...(await service.chat(input, context.mcpReq.signal)) },
          chatOk,
        );
      } catch (error) {
        return result(toolFailure(error), chatOk);
      }
    },
  );
  server.registerTool(
    'sessions',
    {
      description:
        'List/get local session metadata, configure defaults, or DELETE local session data. Never deletes upstream OpenAI data. Instructions and response contents are excluded from metadata.',
      inputSchema: sessionsSchema,
      outputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        return result(service.sessions(input), sessionsOk);
      } catch (error) {
        return result(toolFailure(error), sessionsOk);
      }
    },
  );
  server.registerTool(
    'request_status',
    {
      description:
        'Inspect a known local request, recover its recorded OpenAI response without generating a new one, or explicitly abandon an unresolved request. Abandoning does not cancel upstream work or prevent billing.',
      inputSchema: requestSchema,
      outputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async (input, context) => {
      try {
        return result(
          { ...(await service.requestStatus(input, context.mcpReq.signal)) },
          requestOk,
        );
      } catch (error) {
        return result(toolFailure(error), requestOk);
      }
    },
  );
  return server;
}
