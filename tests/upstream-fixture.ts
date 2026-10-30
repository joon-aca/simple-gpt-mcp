import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';

export function apiResponse(
  id = `resp_${randomUUID()}`,
  status = 'completed',
  message = 'fixture answer',
) {
  return {
    id,
    object: 'response',
    created_at: 1_700_000_000,
    model: 'test-model',
    status,
    error: null,
    incomplete_details:
      status === 'incomplete' ? { reason: 'max_output_tokens' } : null,
    output: message
      ? [
          {
            type: 'message',
            id: 'msg_fixture',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: message, annotations: [] }],
          },
        ]
      : [],
    usage: {
      input_tokens: 12,
      output_tokens: 7,
      total_tokens: 19,
      input_tokens_details: { cached_tokens: 2 },
      output_tokens_details: { reasoning_tokens: 3 },
    },
  };
}
export async function upstreamFixture() {
  const posts: Record<string, unknown>[] = [];
  const gets: string[] = [];
  const responses = new Map<string, ReturnType<typeof apiResponse>>();
  const held = new Set<ServerResponse>();
  // Set getStatus to make retrievals fail transiently, e.g. 429.
  const control: { getStatus?: number } = {};
  const server = createServer(async (req, res) => {
    if (req.method === 'GET') {
      const id = decodeURIComponent(req.url!.split('/').at(-1)!);
      gets.push(id);
      if (control.getStatus) {
        res.writeHead(control.getStatus, {
          'Content-Type': 'application/json',
        });
        res.end(JSON.stringify({ error: { message: 'retry later' } }));
        return;
      }
      const response = responses.get(id);
      res.writeHead(response ? 200 : 404, {
        'Content-Type': 'application/json',
      });
      res.end(
        JSON.stringify(
          response ?? { error: { message: 'not found', type: 'not_found' } },
        ),
      );
      return;
    }
    let body = '';
    for await (const part of req) body += String(part);
    const input = JSON.parse(body) as Record<string, unknown>;
    posts.push(input);
    if (input.input === '[reject]') {
      res.writeHead(400, {
        'Content-Type': 'application/json',
        'x-request-id': 'req_rejected',
      });
      res.end(
        JSON.stringify({
          error: {
            message: 'PRIVATE_UPSTREAM_SECRET echoed from request',
            type: 'invalid_request_error',
            code: 'unsupported_parameter',
            param: 'reasoning.effort',
          },
        }),
      );
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'x-request-id': 'req_fixture',
    });
    const response = apiResponse();
    responses.set(response.id, response);
    const event = (type: string, object: unknown) =>
      res.write(
        `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: 1, ...(object as object) })}\n\n`,
      );
    if (input.input === '[unknown]') {
      res.end();
      return;
    }
    event('response.created', {
      response: { ...response, status: 'in_progress', output: [] },
    });
    if (input.input === '[drop]') {
      res.end();
      return;
    }
    if (input.input === '[stall]') {
      held.add(res);
      res.on('close', () => held.delete(res));
      return;
    }
    // Real streams send one delta event per token; '[huge]' sends one oversized event.
    const deltas =
      input.input === '[long]'
        ? Array.from({ length: 2000 }, () => 'word ')
        : input.input === '[huge]'
          ? ['x'.repeat(20_000)]
          : [];
    for (const delta of deltas)
      event('response.output_text.delta', {
        item_id: 'msg_fixture',
        output_index: 0,
        content_index: 0,
        delta,
        logprobs: [],
        obfuscation: 'padding1234',
      });
    if (input.input === '[incomplete]') {
      event('response.incomplete', {
        response: {
          ...response,
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
        },
      });
    } else if (input.input === '[failed]') {
      event('response.failed', {
        response: {
          ...response,
          status: 'failed',
          error: { code: 'server_error', message: 'PRIVATE_UPSTREAM_SECRET' },
        },
      });
    } else if (input.input === '[refusal]') {
      event('response.completed', {
        response: {
          ...response,
          output: [
            {
              type: 'message',
              content: [
                { type: 'refusal', refusal: 'Cannot help with this request.' },
              ],
            },
          ],
        },
      });
    } else {
      event('response.completed', { response });
    }
    res.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('No fixture address');
  return {
    posts,
    gets,
    responses,
    control,
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    close: async () => {
      for (const res of held) res.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
