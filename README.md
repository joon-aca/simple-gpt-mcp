# simple-gpt-mcp

A small, independent stdio MCP server for OpenAI conversations with persistent sessions and explicit request recovery.

**Version 0.1.0 implements the core chat/session release.** Web search, attachments, and hosted Python remain future milestones in [SPEC.md](SPEC.md).

## Setup

Requires Node.js **22.16.0 or newer** and pnpm (version pinned through `packageManager` in `package.json`). Development is pinned to **22.23.2** in `.node-version`; installation refuses an older Node. CI is configured for Node 22 and 24 on Linux and macOS. Node 22 may print an experimental SQLite warning to stderr; MCP stdout remains intact.

```sh
git clone https://github.com/joon-aca/simple-gpt-mcp.git
cd simple-gpt-mcp
make mcp-config
```

`make mcp-config` installs dependencies when the lockfile changes, builds `dist/`, and prints this checkout's host configuration: JSON for hosts such as Claude Desktop and a `claude mcp add` command for Claude Code. Both use absolute paths to the Node binary and entry point, so hosts without your shell `PATH` still work. Replace the key and model placeholders when pasting; the command never writes credentials anywhere.

The server does not auto-load `.env`; [.env.example](.env.example) lists environment options. An API key is required at startup. A model can instead be supplied in each new `chat` call; no default model is silently selected.

Tests exercise the official current MCP client and a separate 2025-11-25 legacy client. A specific desktop host has not been tested interactively.

## Tools

### `chat`

Start a session:

```json
{
  "message": "Explain this design tradeoff in plain English.",
  "instructions": "Be concise and state important assumptions.",
  "max_output_tokens": 2048
}
```

Continue using its returned ID:

```json
{
  "session_id": "returned-session-uuid",
  "message": "What would you implement first?"
}
```

Replace UUID placeholders with returned IDs. Results include request/session/response IDs, actual model, status, text, effective non-secret settings, and raw token usage. There is no guessed dollar cost. Tools return structured content and a JSON text representation.

Optional settings: `model`, `instructions`, `reasoning_effort`, `verbosity`, `max_output_tokens`, `timeout_ms`. Continuation overrides apply to that call only. Empty `instructions` clears instructions for the call. Stable instructions are resent on every request. OpenAI validates model-specific option compatibility; rejected settings become structured failures rather than automatic downgrades. Failures carry OpenAI's `upstream_code`, `upstream_param`, and `upstream_request_id` when available, for example `unsupported_parameter` on `reasoning.effort`. OpenAI's free-text error message is never returned because it can echo request content.

Supply a UUID `request_id` to safely repeat the exact same call after losing its result. Identical arguments return the existing request/result without another model call; different arguments with the same ID are rejected. Generate the ID once before calling and preserve it across retries. Replay protection ends when the session is deleted.

Completed responses and refusals advance the predecessor pointer. Failed/incomplete responses do not. Only `completed` chat results have `isError: false`; refusals, incomplete results, failures, and replays of running or abandoned requests have explicit statuses and `isError: true`. Unresolved requests block new work on their session.

### `sessions`

```json
{ "operation": "list", "limit": 20 }
```

Metadata is listed in UUID order; pass `next_cursor` as `after` to continue. Fresh state returns an empty list.

```json
{ "operation": "get", "session_id": "returned-session-uuid" }
```

`get` shows defaults, timestamps, latest response ID, and active request ID. Instruction text and model responses are excluded from metadata.

```json
{
  "operation": "configure",
  "session_id": "returned-session-uuid",
  "instructions": "Use concise technical explanations.",
  "max_output_tokens": 4096
}
```

`configure` changes persistent defaults. `delete` with `session_id` removes local session/request/results. Both reject active or unresolved work. **Local deletion does not delete data stored by OpenAI.**

### `request_status`

```json
{ "request_id": "returned-request-uuid", "action": "inspect" }
```

For `recovery_required`, retrieve the locally recorded upstream response:

```json
{ "request_id": "returned-request-uuid", "action": "recover" }
```

Recovery retrieves; it never generates again. An in-progress response remains recoverable, and so does a request whose retrieval failed transiently (rate limit, authentication, server error); retry `recover` later. Only a recorded response that OpenAI no longer has (404) fails recovery for good. If no response ID was received, status is `unknown_outcome`: inspect upstream records before deciding to make a new request.

Explicitly unblock an unresolved session while retaining its previous successful context:

```json
{ "request_id": "returned-request-uuid", "action": "abandon" }
```

Abandonment does not cancel upstream work or prevent billing. Live requests cannot be abandoned; cancel the active call or wait first. After a hard crash, the claim expires at the original deadline plus a 30-second safety window. Stale workers cannot commit over recovered or abandoned work.

## Limits and data handling

| Policy                           | Default                                                         |
| -------------------------------- | --------------------------------------------------------------- |
| Total deadline                   | 120 seconds; per-call override 1–600 seconds                    |
| Output tokens                    | 8192; per-call maximum 32768                                    |
| Combined prompt/instructions     | 256 KiB                                                         |
| Normalized result envelope       | 256 KiB; text/refusal limited to half to reserve metadata space |
| Single stream event or JSON body | 8 × result-byte limit                                           |
| Concurrent requests per database | 4                                                               |
| Sessions / request records       | 1000 / 10000                                                    |
| Content budget                   | 64 MiB, plus bounded metadata and small failure records         |
| Idle session expiry              | 30 days without activity, unless a request is unresolved        |
| Terminal result retention        | 30 days                                                         |

See `.env.example` for configurable policies. Set the MCP host's tool timeout above the server deadline to receive the server's timeout result. Otherwise preserve a client-generated request ID and inspect/recover after reconnecting.

State locations: `~/Library/Application Support/simple-gpt-mcp` on macOS; `$XDG_DATA_HOME/simple-gpt-mcp` or `~/.local/share/simple-gpt-mcp` on Linux; `%LOCALAPPDATA%/simple-gpt-mcp` on Windows. Override with an absolute `SIMPLE_GPT_MCP_DATA_DIR`. CI targets Linux/macOS; Windows is unverified.

SQLite stores persistent session instructions, normalized assistant results, token usage, IDs, settings, and a SHA-256 digest of caller arguments for replay detection. User messages, per-call instruction overrides, keys, and raw payloads are not stored as transcript content. Treat digests as sensitive metadata too. The database is unencrypted; private POSIX permissions apply where supported. Use a dedicated local directory rather than a shared/network filesystem.

Retention runs at startup and on tool use. A session idle for the retention period is deleted with its request history, including replay tombstones, so one-shot questions never exhaust the session or request limits. A session with an unresolved request stays until that request is recovered or abandoned. In sessions still in use, terminal result content older than the retention period is pruned while ID/settings/usage tombstones remain; a pruned replay returns `result_pruned` without generating again. SQLite can retain allocated disk space after pruning; the content budget does not promise a fixed physical database size.

Requests explicitly enable upstream storage for chaining/recovery. Local metadata cannot make remote history persist indefinitely. Missing/expired history requires an explicit new session; context is never silently reset or truncated. [OpenAI instruction-continuity guidance](https://developers.openai.com/api/docs/guides/migrate-to-responses#3-update-multi-turn-conversations).

Logs contain metadata only on stderr. An `INTERNAL_ERROR` result has a matching `internal_error` event with the error class and stable codes (for example `ERR_SQLITE_ERROR` / `database is locked`), never the error message. Content logging is not implemented; SDK logging is forced off even if `OPENAI_LOG` is set. There are no tools for local file access, local code execution, or downstream MCP connections. Optional `OPENAI_BASE_URL` is trusted startup configuration: credentials go to that URL, so use only a trusted service. HTTPS is required except for loopback test endpoints.

## Development and verification

```sh
make check
```

`check` is exactly what CI runs: source/test type checks, lint, a non-mutating format check, build, and tests with coverage gates. Bare `make` lists the other targets (`test`, `dev`, `format`, `audit`, `clean`). Tests use temporary SQLite and a loopback fake OpenAI HTTP server with synthetic credentials. They exercise the actual SDK and stdio processes, restart continuity, two-process exclusion, current/legacy MCP, recovery (including transient retrieval failures), deadlines/cancellation, realistic token-by-token streams, pruning and session expiry, limits, and privacy/error handling.

Coverage gates cover source modules. The entry point is excluded from in-process coverage because protocol tests exercise it as an actual child process.

No live model call is part of testing. A real-account/model smoke test remains a manual, explicitly authorized step. CI includes dependency auditing. The package is not published to npm.

See [SPEC.md](SPEC.md) for decisions, acceptance gates, and future milestones.

## License

[MIT](LICENSE)
