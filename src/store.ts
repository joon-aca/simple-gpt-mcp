import { DatabaseSync } from 'node:sqlite';
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Config } from './config.js';
import type { ChatInput, SessionInput } from './schemas.js';
import type {
  ChatResult,
  Defaults,
  RequestRecord,
  RequestState,
  SessionRecord,
} from './types.js';
import { AppError } from './errors.js';

type Row = Record<string, unknown>;
const text = (v: unknown) =>
  v === null || v === undefined ? undefined : String(v);
const pending = (state: RequestState) =>
  ['running', 'recovery_required', 'unknown_outcome'].includes(state);

export class Store {
  private readonly db: DatabaseSync;
  constructor(
    readonly config: Config,
    private readonly now: () => number = Date.now,
  ) {
    mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    if (lstatSync(config.dataDir).isSymbolicLink())
      throw new AppError(
        'UNSAFE_STATE_PATH',
        'The state directory must not be a symbolic link.',
      );
    chmodSync(config.dataDir, 0o700);
    const file = join(config.dataDir, 'state.sqlite');
    // Never follow a pre-existing symlink for the database.
    try {
      if (lstatSync(file).isSymbolicLink())
        throw new AppError(
          'UNSAFE_STATE_PATH',
          'The state database must not be a symbolic link.',
        );
    } catch (e) {
      if (!(e instanceof Error && 'code' in e && e.code === 'ENOENT')) throw e;
    }
    closeSync(openSync(file, 'a', 0o600));
    chmodSync(file, 0o600);
    this.db = new DatabaseSync(file);
    this.db.exec(
      'PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;',
    );
    const version = Number(
      this.db.prepare('PRAGMA user_version').get()?.user_version,
    );
    if (version > 2) {
      this.db.close();
      throw new AppError(
        'SCHEMA_TOO_NEW',
        'The state database was created by a newer server.',
      );
    }
    if (version === 0)
      this.transaction(() => {
        // Another process may have migrated while this one waited for the lock.
        if (
          Number(this.db.prepare('PRAGMA user_version').get()?.user_version) !==
          0
        )
          return;
        this.db.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY, defaults_json TEXT NOT NULL, response_id TEXT,
          active_request_id TEXT, revision INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE requests (
          id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          digest TEXT NOT NULL, state TEXT NOT NULL, response_id TEXT, owner TEXT,
          lease_until INTEGER, result_json TEXT, options_json TEXT NOT NULL,
          base_revision INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE INDEX requests_session ON requests(session_id, created_at);
        CREATE INDEX requests_updated ON requests(updated_at);
        PRAGMA user_version=1;
      `);
      });
    if (version < 2)
      this.transaction(() => {
        if (
          Number(this.db.prepare('PRAGMA user_version').get()?.user_version) >=
          2
        )
          return;
        this.db.exec(`ALTER TABLE requests ADD COLUMN usage_json TEXT;
        UPDATE requests SET usage_json=json_extract(result_json,'$.usage') WHERE result_json IS NOT NULL;
        PRAGMA user_version=2;`);
      });
    this.prune();
  }

  close() {
    this.db.close();
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private sessionRow(row: Row): SessionRecord {
    return {
      id: String(row.id),
      defaults: JSON.parse(String(row.defaults_json)) as Defaults,
      responseId: text(row.response_id),
      activeRequestId: text(row.active_request_id),
      revision: Number(row.revision),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  private requestRow(row: Row): RequestRecord {
    return {
      id: String(row.id),
      sessionId: String(row.session_id),
      digest: String(row.digest),
      state: row.state as RequestState,
      responseId: text(row.response_id),
      owner: text(row.owner),
      leaseUntil:
        row.lease_until === null ? undefined : Number(row.lease_until),
      result: row.result_json
        ? (JSON.parse(String(row.result_json)) as ChatResult)
        : undefined,
      usage: row.usage_json
        ? (JSON.parse(String(row.usage_json)) as RequestRecord['usage'])
        : undefined,
      options: JSON.parse(String(row.options_json)) as RequestRecord['options'],
      baseRevision: Number(row.base_revision),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  getSession(id: string): SessionRecord {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id=?').get(id);
    if (!row)
      throw new AppError('SESSION_NOT_FOUND', 'No local session has this ID.');
    return this.sessionRow(row);
  }

  getRequest(id: string): RequestRecord {
    const row = this.db.prepare('SELECT * FROM requests WHERE id=?').get(id);
    if (!row)
      throw new AppError('REQUEST_NOT_FOUND', 'No local request has this ID.');
    return this.requestRow(row);
  }

  private resolveOptions(
    input: Partial<Defaults>,
    defaults?: Defaults,
  ): Defaults {
    const model = input.model ?? defaults?.model ?? this.config.model;
    if (!model)
      throw new AppError(
        'MODEL_REQUIRED',
        'Provide model or configure OPENAI_MODEL.',
      );
    const result: Defaults = {
      model,
      instructions: input.instructions ?? defaults?.instructions ?? '',
      reasoning_effort: input.reasoning_effort ?? defaults?.reasoning_effort,
      verbosity: input.verbosity ?? defaults?.verbosity,
      max_output_tokens:
        input.max_output_tokens ??
        defaults?.max_output_tokens ??
        this.config.defaultOutputTokens,
      timeout_ms:
        input.timeout_ms ??
        defaults?.timeout_ms ??
        this.config.defaultTimeoutMs,
    };
    if (Buffer.byteLength(result.instructions) > this.config.maxInputBytes)
      throw new AppError(
        'INPUT_TOO_LARGE',
        'Instructions exceed the configured input limit.',
      );
    if (
      result.max_output_tokens > this.config.maxOutputTokens ||
      result.timeout_ms > this.config.maxTimeoutMs
    )
      throw new AppError(
        'LIMIT_EXCEEDED',
        'Requested output or deadline exceeds server policy.',
      );
    return result;
  }

  private active(session: SessionRecord) {
    if (!session.activeRequestId) return;
    const request = this.getRequest(session.activeRequestId);
    if (
      request.state === 'running' &&
      (request.leaseUntil ?? 0) <= this.now()
    ) {
      const state = request.responseId
        ? 'recovery_required'
        : 'unknown_outcome';
      this.db
        .prepare(
          'UPDATE requests SET state=?, owner=NULL, lease_until=NULL, updated_at=? WHERE id=?',
        )
        .run(state, this.now(), request.id);
      request.state = state;
    }
    if (pending(request.state))
      throw new AppError(
        request.state === 'running' ? 'SESSION_BUSY' : 'SESSION_BLOCKED',
        'This session has an active or unresolved request. Inspect, recover, or explicitly abandon it first.',
        { request_id: request.id, session_id: session.id },
      );
  }

  private enforceStorage(extraBytes = 0) {
    const row = this.db
      .prepare(
        `SELECT
      (SELECT COALESCE(SUM(length(CAST(defaults_json AS BLOB))),0) FROM sessions) +
      (SELECT COALESCE(SUM(COALESCE(length(CAST(result_json AS BLOB)),0)+length(CAST(options_json AS BLOB))),0) FROM requests) AS bytes`,
      )
      .get();
    if (Number(row?.bytes) + extraBytes > this.config.maxStoredBytes)
      throw new AppError(
        'STORAGE_LIMIT',
        'Stored content is at its configured limit. Delete old sessions or increase the storage limit.',
      );
  }

  reserve(input: ChatInput): {
    request: RequestRecord;
    effective?: Defaults;
    session?: SessionRecord;
    replay: boolean;
  } {
    this.prune();
    const id = input.request_id ?? randomUUID();
    // Digest caller intent so retries remain replayable even after defaults change.
    const digest = createHash('sha256')
      .update(
        JSON.stringify({
          message: input.message,
          session_id: input.session_id ?? null,
          model: input.model ?? null,
          instructions: input.instructions ?? null,
          reasoning_effort: input.reasoning_effort ?? null,
          verbosity: input.verbosity ?? null,
          max_output_tokens: input.max_output_tokens ?? null,
          timeout_ms: input.timeout_ms ?? null,
        }),
      )
      .digest('hex');
    return this.transaction(() => {
      const existing = this.db
        .prepare('SELECT * FROM requests WHERE id=?')
        .get(id);
      if (existing) {
        const request = this.requestRow(existing);
        if (request.digest !== digest)
          throw new AppError(
            'REQUEST_ID_CONFLICT',
            'This request ID was already used with different arguments.',
            { request_id: id },
          );
        return { request, replay: true };
      }
      let session = input.session_id
        ? this.getSession(input.session_id)
        : undefined;
      if (session) this.active(session);
      if (
        Number(
          this.db.prepare('SELECT COUNT(*) AS count FROM requests').get()
            ?.count,
        ) >= this.config.maxRequests
      )
        throw new AppError(
          'STORAGE_LIMIT',
          'Request history limit reached. Delete old sessions; idle sessions also expire after the retention period.',
        );
      const running = Number(
        this.db
          .prepare(
            "SELECT COUNT(*) AS count FROM requests WHERE state='running' AND lease_until>?",
          )
          .get(this.now())?.count,
      );
      if (running >= this.config.maxConcurrent)
        throw new AppError(
          'SERVER_BUSY',
          'The server has reached its concurrency limit.',
        );
      const effective = this.resolveOptions(input, session?.defaults);
      if (
        Buffer.byteLength(input.message) +
          Buffer.byteLength(effective.instructions) >
        this.config.maxInputBytes
      )
        throw new AppError(
          'INPUT_TOO_LARGE',
          'Message and instructions exceed the configured input limit.',
        );
      const time = this.now();
      this.enforceStorage(Buffer.byteLength(JSON.stringify(effective)) * 2);
      if (!session) {
        if (
          Number(
            this.db.prepare('SELECT COUNT(*) AS count FROM sessions').get()
              ?.count,
          ) >= this.config.maxSessions
        )
          throw new AppError(
            'STORAGE_LIMIT',
            'Session limit reached. Delete old sessions; idle sessions also expire after the retention period.',
          );
        session = {
          id: randomUUID(),
          defaults: effective,
          revision: 0,
          createdAt: time,
          updatedAt: time,
        };
        this.db
          .prepare(
            'INSERT INTO sessions(id,defaults_json,created_at,updated_at) VALUES(?,?,?,?)',
          )
          .run(session.id, JSON.stringify(effective), time, time);
      }
      const { instructions, ...options } = effective;
      this.db
        .prepare(
          `INSERT INTO requests(id,session_id,digest,state,owner,lease_until,options_json,base_revision,created_at,updated_at)
        VALUES(?,?,?,'running',?,?,?,?,?,?)`,
        )
        .run(
          id,
          session.id,
          digest,
          randomUUID(),
          time + effective.timeout_ms + 30_000,
          JSON.stringify({
            ...options,
            instructions_set: instructions.length > 0,
          }),
          session.revision,
          time,
          time,
        );
      this.db
        .prepare(
          'UPDATE sessions SET active_request_id=?,updated_at=? WHERE id=?',
        )
        .run(id, time, session.id);
      return {
        request: this.getRequest(id),
        effective,
        session,
        replay: false,
      };
    });
  }

  captureResponse(id: string, owner: string, responseId: string) {
    const change = this.db
      .prepare(
        `UPDATE requests SET response_id=?,updated_at=? WHERE id=? AND owner=? AND state='running'`,
      )
      .run(responseId, this.now(), id, owner);
    if (Number(change.changes) !== 1)
      throw new AppError(
        'STALE_REQUEST',
        'This operation no longer owns its session.',
      );
  }

  finish(id: string, owner: string, result: ChatResult): ChatResult {
    return this.transaction(() => {
      const request = this.getRequest(id);
      const session = this.getSession(request.sessionId);
      if (
        request.owner !== owner ||
        request.state !== 'running' ||
        session.activeRequestId !== id ||
        session.revision !== request.baseRevision ||
        (request.leaseUntil ?? 0) <= this.now()
      )
        throw new AppError(
          'STALE_REQUEST',
          'This operation no longer owns its session.',
        );
      result = { ...result, usage: result.usage ?? request.usage ?? null };
      let json = JSON.stringify(result);
      if (Buffer.byteLength(json) > this.config.maxResultBytes)
        throw new AppError(
          'RESULT_TOO_LARGE',
          'The response exceeds the configured result limit.',
        );
      // Keep response IDs and usage even when content cannot fit; recovery can be retried after freeing space.
      try {
        this.enforceStorage(Buffer.byteLength(json));
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        result = {
          ...result,
          status: result.response_id ? 'recovery_required' : 'unknown_outcome',
          message: '',
          error: { code: error.code, message: error.message },
        };
        json = JSON.stringify(result);
      }
      this.db
        .prepare(
          'UPDATE requests SET state=?,response_id=?,result_json=?,owner=NULL,lease_until=NULL,updated_at=?,usage_json=? WHERE id=?',
        )
        .run(
          result.status,
          result.response_id ?? request.responseId ?? null,
          json,
          this.now(),
          result.usage ? JSON.stringify(result.usage) : null,
          id,
        );
      if (!pending(result.status)) {
        const advance =
          result.status === 'completed' || result.status === 'refused';
        this.db
          .prepare(
            'UPDATE sessions SET active_request_id=NULL,response_id=?,revision=revision+1,updated_at=? WHERE id=?',
          )
          .run(
            advance
              ? (result.response_id ?? session.responseId ?? null)
              : (session.responseId ?? null),
            this.now(),
            session.id,
          );
      }
      return result;
    });
  }

  claimRecovery(id: string): RequestRecord {
    return this.transaction(() => {
      let request = this.getRequest(id);
      const session = this.getSession(request.sessionId);
      if (request.state === 'running' && (request.leaseUntil ?? 0) > this.now())
        throw new AppError('REQUEST_BUSY', 'This request is still running.');
      if (!pending(request.state)) return request;
      if (!request.responseId)
        throw new AppError(
          'UNKNOWN_OUTCOME',
          'No upstream response ID was received. Inspect upstream records or explicitly abandon this request; do not blindly retry.',
        );
      if (
        session.activeRequestId !== id ||
        session.revision !== request.baseRevision
      )
        throw new AppError(
          'STALE_REQUEST',
          'This request can no longer update the session.',
        );
      this.db
        .prepare(
          "UPDATE requests SET state='running',owner=?,lease_until=?,updated_at=? WHERE id=?",
        )
        .run(
          randomUUID(),
          this.now() + request.options.timeout_ms + 30_000,
          this.now(),
          id,
        );
      request = this.getRequest(id);
      return request;
    });
  }

  abandon(id: string) {
    return this.transaction(() => {
      const request = this.getRequest(id);
      if (request.state === 'running' && (request.leaseUntil ?? 0) > this.now())
        throw new AppError(
          'REQUEST_BUSY',
          'Wait for cancellation/deadline or the stale-owner window before abandoning active work.',
        );
      if (!pending(request.state)) return;
      this.db
        .prepare(
          "UPDATE requests SET state='abandoned',result_json=NULL,owner=NULL,lease_until=NULL,updated_at=? WHERE id=?",
        )
        .run(this.now(), id);
      this.db
        .prepare(
          'UPDATE sessions SET active_request_id=NULL,revision=revision+1,updated_at=? WHERE id=? AND active_request_id=?',
        )
        .run(this.now(), request.sessionId, id);
    });
  }

  inspect(id: string): RequestRecord {
    return this.transaction(() => {
      const request = this.getRequest(id);
      if (
        request.state === 'running' &&
        (request.leaseUntil ?? 0) <= this.now()
      ) {
        this.db
          .prepare(
            'UPDATE requests SET state=?,owner=NULL,lease_until=NULL,updated_at=? WHERE id=?',
          )
          .run(
            request.responseId ? 'recovery_required' : 'unknown_outcome',
            this.now(),
            id,
          );
      }
      return this.getRequest(id);
    });
  }

  prune() {
    const cutoff = this.now() - this.config.retentionDays * 86_400_000;
    // Idle sessions expire with their request history so one-shot use cannot exhaust the row limits.
    // Sessions holding unresolved work stay until it is recovered or abandoned.
    this.db
      .prepare(
        'DELETE FROM sessions WHERE updated_at<? AND active_request_id IS NULL',
      )
      .run(cutoff);
    this.db
      .prepare(
        "UPDATE requests SET result_json=NULL WHERE updated_at<? AND state NOT IN ('running','recovery_required','unknown_outcome') AND result_json IS NOT NULL",
      )
      .run(cutoff);
  }

  sessions(input: SessionInput): Record<string, unknown> {
    this.prune();
    return this.transaction(() => {
      if (input.operation === 'list') {
        const rows = this.db
          .prepare(
            'SELECT * FROM sessions WHERE (? IS NULL OR id>?) ORDER BY id LIMIT ?',
          )
          .all(input.after ?? null, input.after ?? null, input.limit + 1);
        const items = rows
          .slice(0, input.limit)
          .map((row) => this.publicSession(this.sessionRow(row)));
        return {
          status: 'ok',
          sessions: items,
          next_cursor:
            rows.length > input.limit ? items.at(-1)?.session_id : null,
        };
      }
      let session = this.getSession(input.session_id);
      if (input.operation === 'get')
        return { status: 'ok', session: this.publicSession(session) };
      this.active(session);
      if (input.operation === 'delete') {
        this.db.prepare('DELETE FROM sessions WHERE id=?').run(session.id);
        return {
          status: 'deleted',
          session_id: session.id,
          scope: 'local_only',
          remote_data_deleted: false,
        };
      }
      const defaults = this.resolveOptions(input, session.defaults);
      this.enforceStorage(Buffer.byteLength(JSON.stringify(defaults)));
      this.db
        .prepare(
          'UPDATE sessions SET defaults_json=?,revision=revision+1,updated_at=? WHERE id=?',
        )
        .run(JSON.stringify(defaults), this.now(), session.id);
      session = this.getSession(session.id);
      return { status: 'configured', session: this.publicSession(session) };
    });
  }

  private publicSession(session: SessionRecord) {
    const { instructions, ...defaults } = session.defaults;
    return {
      session_id: session.id,
      defaults: { ...defaults, instructions_set: instructions.length > 0 },
      response_id: session.responseId ?? null,
      active_request_id: session.activeRequestId ?? null,
      created_at: new Date(session.createdAt).toISOString(),
      updated_at: new Date(session.updatedAt).toISOString(),
    };
  }
}
