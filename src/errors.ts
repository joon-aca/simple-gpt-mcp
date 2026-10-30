import { log } from './logging.js';
import type { UpstreamDetails } from './types.js';

export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function safeError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  // Record only the error class and stable codes; messages can contain paths or content.
  const { code, errstr } = (error ?? {}) as {
    code?: unknown;
    errstr?: unknown;
  };
  log('internal_error', {
    error_name: error instanceof Error ? error.name : typeof error,
    ...((typeof code === 'string' || typeof code === 'number') && {
      error_code: String(code),
    }),
    ...(typeof errstr === 'string' && { sqlite_error: errstr }),
  });
  return new AppError(
    'INTERNAL_ERROR',
    'The operation failed. See the internal_error event in the server stderr log.',
  );
}

export function errorData(error: AppError) {
  return { code: error.code, message: error.message, ...error.details };
}

const UPSTREAM_KEYS = [
  'upstream_request_id',
  'upstream_code',
  'upstream_param',
] as const;

export function upstreamDetails(
  details: Partial<Record<keyof UpstreamDetails, unknown>>,
): UpstreamDetails {
  const result: UpstreamDetails = {};
  for (const key of UPSTREAM_KEYS) {
    const value = details[key];
    if (typeof value === 'string') result[key] = value;
  }
  return result;
}
