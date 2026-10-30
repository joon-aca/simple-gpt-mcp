import type { Config } from './config.js';
import { AppError, errorData, safeError, upstreamDetails } from './errors.js';
import { log } from './logging.js';
import type { Outcome, UpstreamAdapter } from './openai-adapter.js';
import { ResponseLimitError, UpstreamError } from './openai-adapter.js';
import { chatSchema, requestSchema, sessionsSchema } from './schemas.js';
import { Store } from './store.js';
import type { ChatResult, RequestRecord } from './types.js';

export class ChatService {
  private readonly shutdownController = new AbortController();
  private readonly operations = new Set<Promise<unknown>>();
  constructor(
    readonly store: Store,
    private readonly adapter: UpstreamAdapter,
    private readonly config: Config,
  ) {}

  async close() {
    this.shutdownController.abort();
    await Promise.allSettled([...this.operations]);
    this.store.close();
  }

  private track<T>(operation: () => Promise<T>): Promise<T> {
    if (this.shutdownController.signal.aborted)
      return Promise.reject(
        new AppError('SERVER_CLOSING', 'The server is shutting down.'),
      );
    const task = operation();
    this.operations.add(task);
    void task.finally(() => this.operations.delete(task)).catch(() => {});
    return task;
  }

  chat(raw: unknown, signal?: AbortSignal) {
    return this.track(async () => {
      const input = chatSchema.parse(raw);
      signal?.throwIfAborted();
      const reservation = this.store.reserve(input);
      if (reservation.replay)
        return this.describe(this.store.inspect(reservation.request.id));
      const { request, effective, session } = reservation;
      if (!effective || !session)
        throw new AppError(
          'INTERNAL_ERROR',
          'Request reservation is incomplete.',
        );
      return this.execute(request, signal, (context) =>
        this.adapter.create(
          {
            message: input.message,
            defaults: effective,
            previousResponseId: session.responseId,
          },
          context,
        ),
      );
    });
  }

  sessions(raw: unknown) {
    return this.store.sessions(sessionsSchema.parse(raw));
  }

  requestStatus(raw: unknown, signal?: AbortSignal) {
    return this.track(async () => {
      const input = requestSchema.parse(raw);
      this.store.prune();
      if (input.action === 'abandon') this.store.abandon(input.request_id);
      if (input.action !== 'recover')
        return this.describe(this.store.inspect(input.request_id));
      const request = this.store.claimRecovery(input.request_id);
      if (request.state !== 'running') return this.describe(request);
      return this.execute(request, signal, (context) =>
        this.adapter.retrieve(request.responseId!, context),
      );
    });
  }

  private describe(request: RequestRecord): Record<string, unknown> {
    if (request.result && request.result.status === request.state)
      return { ...request.result, cached: true };
    const pruned = ![
      'running',
      'recovery_required',
      'unknown_outcome',
      'abandoned',
    ].includes(request.state);
    return {
      status: pruned ? 'result_pruned' : request.state,
      request_state: request.state,
      request_id: request.id,
      session_id: request.sessionId,
      response_id: request.responseId ?? null,
      result_available: false,
      result_pruned: pruned,
      usage: request.usage ?? null,
      next_step:
        request.state === 'running'
          ? 'Wait or cancel the active call.'
          : request.responseId && request.state === 'recovery_required'
            ? 'Use request_status with action recover, or explicitly abandon.'
            : request.state === 'unknown_outcome'
              ? 'Inspect upstream records or explicitly abandon; no automatic retry will be made.'
              : 'No new upstream request was made.',
    };
  }

  private async execute(
    request: RequestRecord,
    callerSignal: AbortSignal | undefined,
    operation: (context: {
      signal: AbortSignal;
      onResponseId: (id: string) => void;
    }) => Promise<Outcome>,
  ): Promise<ChatResult> {
    const started = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(
      () =>
        controller.abort(
          new AppError(
            'DEADLINE_EXCEEDED',
            'The total request deadline expired.',
          ),
        ),
      request.options.timeout_ms,
    );
    const combined = AbortSignal.any([
      controller.signal,
      this.shutdownController.signal,
      ...(callerSignal ? [callerSignal] : []),
    ]);
    const owner = request.owner!;
    const { model, ...options } = request.options;
    let responseId = request.responseId;
    let outcome: Outcome | undefined;
    const context = {
      signal: combined,
      onResponseId: (id: string) => {
        this.store.captureResponse(request.id, owner, id);
        responseId = id;
      },
    };
    log('request_started', {
      request_id: request.id,
      session_id: request.sessionId,
    });
    try {
      // Race enforces total duration even if an adapter fails to honor its abort signal.
      outcome = await new Promise<Outcome>((resolve, reject) => {
        const abort = () => reject(combined.reason);
        if (combined.aborted) {
          reject(combined.reason);
          return;
        }
        combined.addEventListener('abort', abort, { once: true });
        void Promise.resolve()
          .then(() => operation(context))
          .then(resolve, reject)
          .finally(() => combined.removeEventListener('abort', abort));
      });
      responseId = outcome.responseId;
      const result: ChatResult = {
        request_id: request.id,
        session_id: request.sessionId,
        response_id: responseId,
        model: outcome.model,
        status: outcome.state,
        message: outcome.message,
        usage: outcome.usage,
        options,
        ...(outcome.refusal && { refusal: outcome.refusal }),
        ...(outcome.incompleteReason && {
          incomplete_reason: outcome.incompleteReason,
        }),
        ...(outcome.state === 'failed' && {
          error: {
            code: 'UPSTREAM_FAILED',
            message:
              'The upstream response ended in a failed or cancelled state.',
          },
        }),
      };
      const saved = this.store.finish(request.id, owner, result);
      log('request_finished', {
        request_id: request.id,
        status: saved.status,
        duration_ms: Date.now() - started,
      });
      return saved;
    } catch (error) {
      let safe: AppError;
      if (combined.aborted)
        safe =
          combined.reason instanceof AppError
            ? combined.reason
            : new AppError(
                'CANCELLED',
                'The client or server cancelled this operation. Upstream completion may still be uncertain.',
              );
      else safe = safeError(error);
      const definitive = error instanceof UpstreamError && error.definitive;
      const result: ChatResult = {
        request_id: request.id,
        session_id: request.sessionId,
        response_id: responseId,
        model:
          error instanceof ResponseLimitError
            ? error.model
            : (outcome?.model ?? model),
        status: definitive
          ? 'failed'
          : responseId
            ? 'recovery_required'
            : 'unknown_outcome',
        message: '',
        usage:
          error instanceof ResponseLimitError
            ? error.usage
            : (outcome?.usage ?? null),
        options,
        error: {
          code: safe.code,
          message: safe.message,
          ...upstreamDetails(safe.details),
        },
      };
      // Persistence errors must escape as tool failures. Never claim a result was saved when it was not.
      const saved = this.store.finish(request.id, owner, result);
      log('request_interrupted', {
        request_id: request.id,
        status: saved.status,
        code: safe.code,
      });
      return saved;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function toolFailure(error: unknown) {
  const safe = safeError(error);
  log('tool_error', { code: safe.code });
  return { status: 'error', error: errorData(safe) };
}
