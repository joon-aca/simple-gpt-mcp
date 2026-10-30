import { homedir, platform } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { AppError } from './errors.js';

export interface Config {
  apiKey: string;
  model?: string;
  dataDir: string;
  baseURL?: string;
  maxInputBytes: number;
  maxResultBytes: number;
  maxOutputTokens: number;
  defaultOutputTokens: number;
  maxTimeoutMs: number;
  defaultTimeoutMs: number;
  maxConcurrent: number;
  retentionDays: number;
  maxSessions: number;
  maxRequests: number;
  maxStoredBytes: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (!env.OPENAI_API_KEY?.trim())
    throw new AppError(
      'CONFIGURATION_ERROR',
      'Set OPENAI_API_KEY in the MCP server environment.',
    );
  const number = (key: string, fallback: number, min: number, max: number) => {
    const value = env[key] === undefined ? fallback : Number(env[key]);
    if (!Number.isSafeInteger(value) || value < min || value > max)
      throw new AppError(
        'CONFIGURATION_ERROR',
        `Invalid ${key}; expected an integer from ${min} to ${max}.`,
      );
    return value;
  };
  const root =
    platform() === 'darwin'
      ? join(homedir(), 'Library', 'Application Support')
      : platform() === 'win32'
        ? env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
        : env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  const dataDir = env.SIMPLE_GPT_MCP_DATA_DIR || join(root, 'simple-gpt-mcp');
  if (!isAbsolute(dataDir))
    throw new AppError(
      'CONFIGURATION_ERROR',
      'SIMPLE_GPT_MCP_DATA_DIR must be absolute.',
    );
  if (env.OPENAI_BASE_URL) {
    let url: URL;
    try {
      url = new URL(env.OPENAI_BASE_URL);
    } catch {
      throw new AppError(
        'CONFIGURATION_ERROR',
        'OPENAI_BASE_URL must be a valid URL.',
      );
    }
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== 'https:' &&
        !(
          url.protocol === 'http:' &&
          ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
        ))
    ) {
      throw new AppError(
        'CONFIGURATION_ERROR',
        'OPENAI_BASE_URL requires HTTPS (HTTP is allowed only on loopback), without credentials, query, or fragment.',
      );
    }
  }
  return {
    apiKey: env.OPENAI_API_KEY,
    model: env.OPENAI_MODEL?.trim() || undefined,
    dataDir,
    baseURL: env.OPENAI_BASE_URL,
    maxInputBytes: number(
      'SIMPLE_GPT_MCP_MAX_INPUT_BYTES',
      262_144,
      1024,
      1_048_576,
    ),
    maxResultBytes: number(
      'SIMPLE_GPT_MCP_MAX_RESULT_BYTES',
      262_144,
      1024,
      1_048_576,
    ),
    maxOutputTokens: 32_768,
    defaultOutputTokens: 8192,
    maxTimeoutMs: 600_000,
    defaultTimeoutMs: number(
      'SIMPLE_GPT_MCP_TIMEOUT_MS',
      120_000,
      1000,
      600_000,
    ),
    maxConcurrent: number('SIMPLE_GPT_MCP_MAX_CONCURRENT', 4, 1, 16),
    retentionDays: number('SIMPLE_GPT_MCP_RETENTION_DAYS', 30, 1, 365),
    maxSessions: number('SIMPLE_GPT_MCP_MAX_SESSIONS', 1000, 1, 100_000),
    maxRequests: number('SIMPLE_GPT_MCP_MAX_REQUESTS', 10_000, 1, 1_000_000),
    maxStoredBytes: number(
      'SIMPLE_GPT_MCP_MAX_STORED_BYTES',
      67_108_864,
      1_048_576,
      1_073_741_824,
    ),
  };
}
