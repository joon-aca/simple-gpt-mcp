import OpenAI from 'openai';
import type { Response } from 'openai/resources/responses/responses';
import type { Config } from './config.js';
import type { Defaults, UpstreamDetails, Usage } from './types.js';
import { AppError, upstreamDetails } from './errors.js';

export interface Outcome {
  responseId: string;
  model: string;
  state:
    'completed' | 'refused' | 'incomplete' | 'failed' | 'recovery_required';
  message: string;
  usage: Usage | null;
  refusal?: string;
  incompleteReason?: string;
  upstreamRequestId?: string;
}
export interface AdapterContext {
  signal: AbortSignal;
  onResponseId: (id: string) => void;
}
export interface UpstreamAdapter {
  create(
    input: { message: string; defaults: Defaults; previousResponseId?: string },
    context: AdapterContext,
  ): Promise<Outcome>;
  retrieve(id: string, context: AdapterContext): Promise<Outcome>;
}

export class UpstreamError extends AppError {
  constructor(
    code: string,
    message: string,
    readonly definitive: boolean,
    upstream: UpstreamDetails = {},
  ) {
    super(code, message, upstreamDetails(upstream));
  }
}

// OpenAI error codes and params are identifiers; drop anything else rather than echo it.
const identifier = (value: unknown) =>
  typeof value === 'string' && /^[\w.[\]-]{1,128}$/.test(value)
    ? value
    : undefined;

/**
 * Bound what the SDK must buffer at once: each SSE event, or a whole JSON body.
 * A stream's total size is bounded by output tokens and the request deadline, not here.
 */
function limitBody(
  response: globalThis.Response,
  limit: number,
): globalThis.Response {
  if (!response.body) return response;
  const source = response.body.getReader();
  const eventStream =
    response.headers.get('content-type')?.startsWith('text/event-stream') ??
    false;
  let pending = 0;
  let afterNewline = false;
  let failure: AppError | undefined;
  const fail = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    controller.error(failure);
    source.cancel(failure).catch(() => {});
  };
  // Pull-based with no read-ahead: events completed before an oversized one are consumed
  // (e.g. response.created carrying the recovery ID) before the error surfaces, since
  // erroring a stream discards anything still queued.
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (failure) return fail(controller);
        const { done, value } = await source.read();
        if (done) return controller.close();
        let complete = 0;
        if (!eventStream) pending += value.byteLength;
        // A blank line ends an SSE event; CR bytes do not affect boundaries.
        else
          for (let i = 0; i < value.byteLength; i++) {
            const byte = value[i];
            if (byte === 0x0a) {
              if (afterNewline) {
                pending = 0;
                complete = i + 1;
              }
              afterNewline = true;
            } else if (byte !== 0x0d) {
              afterNewline = false;
              if (++pending > limit) break;
            }
          }
        if (pending <= limit) return controller.enqueue(value);
        failure = new AppError(
          'STREAM_LIMIT',
          'An upstream event or response body exceeded its byte limit.',
        );
        if (complete === 0) return fail(controller);
        controller.enqueue(value.subarray(0, complete));
      },
      cancel: (reason) => source.cancel(reason),
    },
    { highWaterMark: 0 },
  );
  return new globalThis.Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export class ResponseLimitError extends AppError {
  constructor(
    readonly usage: Usage | null,
    readonly model: string,
  ) {
    super(
      'RESULT_TOO_LARGE',
      'The response exceeds the configured result limit. Its ID and known usage are retained for recovery.',
    );
  }
}

export function normalizeResponse(
  response: Response,
  maxBytes: number,
): Outcome {
  const messages: string[] = [];
  const refusals: string[] = [];
  for (const item of response.output ?? []) {
    if (item.type === 'message') {
      for (const content of item.content) {
        if (content.type === 'output_text') messages.push(content.text);
        else if (content.type === 'refusal') refusals.push(content.refusal);
      }
    }
  }
  const message = messages.join('\n');
  const refusal = refusals.length ? refusals.join('\n') : undefined;
  const u = response.usage;
  const usage: Usage | null = u
    ? {
        input_tokens: u.input_tokens,
        output_tokens: u.output_tokens,
        total_tokens: u.total_tokens,
        cached_input_tokens: u.input_tokens_details?.cached_tokens,
        reasoning_tokens: u.output_tokens_details?.reasoning_tokens,
      }
    : null;
  if (
    Buffer.byteLength(message) + Buffer.byteLength(refusal ?? '') >
    maxBytes / 2
  )
    throw new ResponseLimitError(usage, response.model);
  const state =
    response.status === 'completed'
      ? refusal
        ? 'refused'
        : message.length
          ? 'completed'
          : 'incomplete'
      : response.status === 'incomplete'
        ? 'incomplete'
        : response.status === 'failed' || response.status === 'cancelled'
          ? 'failed'
          : 'recovery_required';
  return {
    responseId: response.id,
    model: response.model,
    state,
    message,
    refusal,
    incompleteReason:
      response.incomplete_details?.reason ??
      (state === 'incomplete' && !message ? 'no_text_output' : undefined),
    usage,
  };
}

export class OpenAIAdapter implements UpstreamAdapter {
  private readonly client: OpenAI;
  constructor(private readonly config: Config) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      maxRetries: 0,
      logLevel: 'off',
      timeout: config.maxTimeoutMs,
      fetch: async (input, init) =>
        limitBody(await fetch(input, init), config.maxResultBytes * 8),
    });
  }

  private rethrow(error: unknown, operation: 'create' | 'retrieve'): never {
    if (error instanceof AppError) throw error;
    if (error instanceof OpenAI.APIError) {
      const status = error.status;
      const upstream = {
        upstream_request_id: error.requestID ?? undefined,
        upstream_code: identifier(error.code),
        upstream_param: identifier(error.param),
      };
      if (operation === 'retrieve' && status === 404)
        throw new UpstreamError(
          'UPSTREAM_NOT_FOUND',
          'The recorded response is no longer available upstream and cannot be recovered. Abandon the request to continue the session.',
          true,
          upstream,
        );
      // A 4xx creation was never accepted. A failed retrieval says nothing about the recorded response, so it stays recoverable.
      const definitive =
        operation === 'create' &&
        status !== undefined &&
        status >= 400 &&
        status < 500 &&
        status !== 408;
      const code =
        status === 404
          ? 'UPSTREAM_NOT_FOUND'
          : status === 401 || status === 403
            ? 'UPSTREAM_AUTH_ERROR'
            : status === 429
              ? 'UPSTREAM_RATE_LIMIT'
              : 'UPSTREAM_ERROR';
      const reason = upstream.upstream_code
        ? ` (${upstream.upstream_code}${upstream.upstream_param ? `: ${upstream.upstream_param}` : ''})`
        : '';
      throw new UpstreamError(
        code,
        status === 404
          ? `The model or previous response was not found${reason}. Check the model; expired history requires an explicit new session.`
          : definitive
            ? `OpenAI rejected the request${reason}. Check model access and supported options.`
            : `OpenAI could not complete the request${reason}. Inspect or recover it using the request ID.`,
        definitive,
        upstream,
      );
    }
    throw new UpstreamError(
      'UPSTREAM_CONNECTION_ERROR',
      'The upstream connection ended without a confirmed result. Do not blindly retry.',
      false,
    );
  }

  async create(
    input: { message: string; defaults: Defaults; previousResponseId?: string },
    context: AdapterContext,
  ): Promise<Outcome> {
    try {
      const { defaults } = input;
      const { data: stream, request_id: requestId } =
        await this.client.responses
          .create(
            {
              model: defaults.model,
              input: input.message,
              instructions: defaults.instructions,
              previous_response_id: input.previousResponseId,
              max_output_tokens: defaults.max_output_tokens,
              ...(defaults.reasoning_effort !== undefined && {
                reasoning: { effort: defaults.reasoning_effort },
              }),
              ...(defaults.verbosity !== undefined && {
                text: { verbosity: defaults.verbosity },
              }),
              stream: true,
              store: true,
              truncation: 'disabled',
            },
            { signal: context.signal },
          )
          .withResponse();
      const upstream = { upstream_request_id: requestId ?? undefined };
      let responseId: string | undefined;
      for await (const event of stream) {
        if (
          'response' in event &&
          event.response &&
          responseId !== event.response.id
        ) {
          responseId = event.response.id;
          context.onResponseId(responseId);
        }
        if (
          event.type === 'response.completed' ||
          event.type === 'response.incomplete' ||
          event.type === 'response.failed'
        ) {
          return {
            ...normalizeResponse(event.response, this.config.maxResultBytes),
            upstreamRequestId: requestId ?? undefined,
          };
        }
        if (event.type === 'error')
          throw new UpstreamError(
            'UPSTREAM_STREAM_ERROR',
            'The upstream reported a streaming error. Inspect or recover the request.',
            false,
            upstream,
          );
      }
      throw new UpstreamError(
        'STREAM_INTERRUPTED',
        'The stream ended without a terminal response. Inspect or recover the request.',
        false,
        upstream,
      );
    } catch (error) {
      this.rethrow(error, 'create');
    }
  }

  async retrieve(id: string, context: AdapterContext): Promise<Outcome> {
    try {
      const response = await this.client.responses.retrieve(id, {
        signal: context.signal,
      });
      if (response.id !== id)
        throw new UpstreamError(
          'RESPONSE_ID_MISMATCH',
          'The returned response does not match the locally recorded response ID.',
          false,
        );
      context.onResponseId(response.id);
      return normalizeResponse(response, this.config.maxResultBytes);
    } catch (error) {
      this.rethrow(error, 'retrieve');
    }
  }
}
