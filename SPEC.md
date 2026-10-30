# simple-gpt-mcp specification and roadmap

Status: milestones 0–2 implemented as local version 0.1.0. Milestones 3–5 remain planned.

Created: 2026-10-30. Initial target: a local, single-user MCP server over stdio.

## 1. Purpose and priorities

Let an existing agent or MCP client ask an OpenAI model a question, continue the conversation later, and receive an honest, structured result.

Priority order:

1. Correct behavior that matches the documented contract.
2. Explicit permissions and sensible handling of sensitive data.
3. Small, maintainable code with meaningful tests.

Success means a client can start a conversation, restart the MCP server, continue that conversation, and understand whether each request completed, failed, or requires recovery. Two overlapping calls must never silently overwrite each other's state.

This is an independent implementation, written from the official OpenAI and MCP documentation and these requirements. It reuses no implementation, tests, or documentation from other GPT MCP servers; known failure modes of such servers inform the acceptance cases only.

## 2. Scope

### Initial release

- MCP stdio transport with runtime-validated tool inputs and structured results.
- OpenAI Responses API through the official TypeScript SDK.
- New conversations and continuation by locally generated session ID.
- Persistent model and instructions, with explicit per-call overrides.
- SQLite persistence for sessions, request state, normalized results, and usage.
- Per-session request serialization, bounded execution, and cancellation handling.
- Request identifiers, response identifiers, and recoverable interrupted requests.
- Metadata-only diagnostic logging by default.

### Subsequent releases

- Hosted web search, including returned citations and requested source lists.
- Explicit image/document attachments with directory and size restrictions.
- Hosted Python execution, with explicit uploads and downloads.
- Optional vector search only after a concrete workflow needs it.

### Outside the initial scope

- Inline JavaScript implementations, eval, shell execution, or local agent execution.
- Downstream MCP server passthrough or automatic subprocess discovery.
- Automatic two-way filesystem mirroring or automatic restoration into replacement containers.
- HTTP hosting, shared/multi-user service, accounts, or a web interface.
- Automatic model selection, embedded pricing tables, or claims of exact dollar cost.
- Compatibility with other GPT MCP servers' tool APIs or session files.

## 3. Core tool contract

Keep tools specific enough that their schemas and effects are clear. The three tools below are implemented in version 0.1.0; README.md documents their current examples and limits.

### `chat`

Inputs:

| Field               | Behavior                                                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `message`           | Required nonempty string; reject invalid input before network access.                                                       |
| `session_id`        | Optional local ID; omission creates a new session. Unknown IDs fail rather than silently starting over.                     |
| `request_id`        | Optional client-supplied UUID for replay protection; otherwise the server generates one.                                    |
| `model`             | Optional override; resolve from the call, existing session, then `OPENAI_MODEL`. Fail clearly if none is configured.        |
| `instructions`      | Optional instruction override for this request. An empty string explicitly clears instructions for the request.             |
| `reasoning_effort`  | Optional model-supported value; validate against the supported configuration rather than guessing or silently changing it.  |
| `verbosity`         | Optional model-supported value.                                                                                             |
| `max_output_tokens` | Optional positive integer, bounded by server policy. Includes reasoning tokens where the model/API applies that accounting. |
| `timeout_ms`        | Optional total request deadline, bounded by server policy.                                                                  |

Persist defaults when a session is created. Overrides on a continuation apply to that call; updating persistent defaults uses `sessions.configure`. Return the effective model and options so the choice is observable. Reuse of a request ID with different caller arguments fails with `REQUEST_ID_CONFLICT`. The digest records caller intent so an identical retry remains replayable after defaults change.

Successful output contains `request_id`, `session_id`, `response_id`, `model`, `status`, `message`, normalized usage, and any enabled capability results. Never return a successful empty result merely because a response is incomplete, failed, refused, or still in progress. Represent refusals and partial results explicitly.

Use MCP structured output plus a readable text representation where needed for client compatibility. Preserve useful OpenAI request IDs in diagnostics without leaking credentials.

### `sessions`

Use a discriminated input schema for these operations:

- `list`: paginated session metadata; an empty database returns an empty list.
- `get`: metadata, effective defaults, latest committed response, and active/recoverable request status. Do not expose stored content implicitly.
- `configure`: update persistent model/instructions/options when no request is active; validate before applying.
- `delete`: explicitly delete local session data and associated local artifacts, with destructive tool annotations. Reject deletion during active work.

Describe the deletion boundary in the result: deleting local data does not imply deletion of responses/files stored by OpenAI. Remote cleanup requires a separately designed explicit operation.

### `request_status`

Look up a locally known `request_id`. Return its state and identifiers. If a response ID was recorded before interruption, an explicit recovery option may retrieve that response and finalize it after checking its terminal status. Recovery must not generate a new model response, execute tools, or accept an arbitrary unrelated response ID.

Return a cached normalized result for an already completed request while it is retained locally. If that result was pruned, return `result_pruned` and retained usage; do not silently reissue the request. An explicit `action: "abandon"` releases an unresolved session without cancelling remote work or advancing its successful predecessor.

## 4. Request and session lifecycle

1. Validate and normalize the entire input before changing state or making a network call.
2. Resolve or create the session. Record the request ID before contacting OpenAI.
3. Atomically claim the session for this operation. Another process or concurrent call must receive `SESSION_BUSY`, or wait within an explicitly bounded queue; initial implementation should fail fast.
4. Read the latest committed response ID and effective session defaults under that claim.
5. Build the request with explicit instructions on every API round, including future function/tool continuations. Use `previous_response_id` for continuity.
6. Capture response IDs from streaming lifecycle events as soon as available and persist them for recovery.
7. Consume the stream within the total deadline. Handle completed, incomplete, failed, cancelled, refusal, malformed stream, and disconnected stream cases distinctly.
8. Commit the successful response pointer, normalized result, and usage atomically. Failed/ambiguous requests do not advance the conversation silently.
9. Release the session claim. On a crash, a stale claim must be recoverable without allowing an old worker to commit over newer work.

Do not hold an SQLite transaction open during a network request. Use short transactional claims with ownership/fencing, plus a tested stale-owner policy, or another explicit cross-process exclusion mechanism. An in-memory mutex alone is insufficient when two MCP clients launch separate server processes against the same database.

Do not blindly retry ambiguous response-creation requests: a disconnected call may already have been accepted and billed. Review SDK retry settings explicitly. Retry only failures whose semantics are understood; otherwise expose `RECOVERY_REQUIRED` or an honest `UNKNOWN_OUTCOME` state.

OpenAI-managed response history has retention/account-policy limits. Local session metadata does not guarantee indefinite remote conversation continuity. If a predecessor is unavailable, explain the problem and require an explicit restart/context restoration decision. Do not silently drop history or enable truncation.

## 5. Persistence and privacy

Proposed tables:

| Table               | Contents                                                                                                                |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `sessions`          | UUID, timestamps, persistent defaults/instructions, latest successful response ID, version.                             |
| `requests`          | UUID, session ID, caller-argument digest, state, response ID, timestamps, normalized result, usage, safe error details. |
| `session_claims`    | Session ID, request/owner identifiers, claim lifetime and fencing version if leases are used.                           |
| `artifacts` (later) | Local artifact ID, owning session, remote identifiers, safe destination, size/hash, transfer status.                    |

Use an explicit schema version and tested migrations. Enable foreign keys. Keep completed-request usage independently recorded so failures after partial work do not erase known usage.

Store the database in a configurable application data directory; do not implicitly scatter state into each requested working directory. Create private directories/files with restrictive permissions where supported. Validate IDs as IDs and store them in database fields rather than interpolating them into paths or SQL.

By default retain the instructions and normalized assistant results needed for configuration and request recovery, with a documented bounded retention policy. User prompts, attachment contents, tool outputs, and raw API payloads are not diagnostic logs. Full local transcripts are optional and must have explicit retention/deletion controls. The specification must clearly disclose what remains in SQLite and what is sent/stored upstream.

Environment credentials never enter the database, returned tool content, logs, or committed files. API base URL overrides, if supported, are trusted startup configuration only; tool callers cannot redirect credentials to an arbitrary endpoint.

## 6. Implementation structure

Use TypeScript with strict checking, the official MCP SDK, the official OpenAI SDK, runtime schemas, and SQLite. Pin a supported Node LTS runtime and compatible dependency versions at implementation time. Document the actual supported runtime rather than advertising older versions without testing them.

Suggested modules:

```text
src/
  index.ts               # Startup, stdio transport, shutdown
  config.ts              # Trusted environment configuration and limits
  tools/                 # Public schemas and thin handlers
  chat-service.ts        # Single orchestration path
  openai-adapter.ts      # SDK boundary and stream normalization
  store/                 # SQLite schema, migrations, claims and queries
  errors.ts              # Stable error codes and safe MCP mapping
  logging.ts             # Redacted metadata diagnostics to stderr
  capabilities/          # Added only with implemented milestones
tests/
  protocol/              # Exercise the actual public MCP server
  integration/           # Real SQLite with a controlled upstream adapter
  unit/                  # Pure transformations and schema behavior
```

Inject the upstream adapter, clock, and state path for deterministic tests. Test real production helpers rather than copying them into test files. Keep one orchestration implementation shared by new and continuing sessions.

## 7. Operational boundaries

- Stdio only; stdout contains MCP protocol messages and nothing else.
- Total deadlines cover stream consumption, not just receipt of headers.
- Forward cancellation to the request where supported; report uncertain upstream completion honestly.
- Bound message/input size, output tokens, concurrent requests, stored content, and later file transfer sizes.
- Default logs contain event names, safe IDs, timings, token counts, and redacted errors. Content logging requires explicit opt-in.
- Raw token usage is authoritative; distinguish known usage from unknown usage after interrupted work. Sum usage across all billable rounds when multi-round workflows exist.
- Estimated dollar prices, if ever added, must be dated, labelled estimates, and separate from usage. Missing prices must not appear as zero cost.
- Unsupported model/parameter combinations return clear errors. Do not silently downgrade the model or ignore settings.

## 8. Roadmap and acceptance gates

### Milestone 0 — Repository and specification

- [x] Create the `simple-gpt-mcp` repository with `master` as its initial branch.
- [x] Add this specification, a concise README, and runtime/secret exclusions.
- [x] Resolve the pre-implementation decisions in section 9.

### Milestone 1 — Small working chat server

Depends on milestone 0.

- [x] Initialize the TypeScript package, pinned runtime, SDK dependencies, and lockfile.
- [x] Implement configuration validation, MCP startup, and the first `chat` schema.
- [x] Add an injectable Responses API adapter with explicit stream-status handling.
- [x] Return effective model, response ID, normalized text/status, and raw usage.
- [x] Add total deadlines, cancellation handling, safe errors, and metadata logging.

Gate: an actual MCP client can initialize/list/call the built server against a local controlled upstream. Bad input makes no upstream call. stdout stays valid. Incomplete/failed/refused/disconnected responses have truthful outcomes. Tests need no real API key.

### Milestone 2 — Durable sessions and recovery (initial usable release)

Depends on milestone 1.

- [x] Implement SQLite migrations and session/request storage.
- [x] Add `sessions` and `request_status` with validated operation schemas.
- [x] Implement persistent defaults and explicit per-call overrides.
- [x] Persist early response IDs; recover known interrupted requests without creating duplicates.
- [x] Implement and test cross-process session exclusion and crash/stale-owner handling.
- [x] Add retention/pruning and document local/upstream storage boundaries.

Gate: continue a session after restart; verify instructions on every round; reject conflicting concurrent requests across two processes; recover after a simulated disconnect; reject reused request IDs with different inputs; safely handle missing/expired remote responses. Fresh state lists no sessions. Database failure cannot produce a false success.

### Milestone 3 — Hosted web search and explicit attachments

Depends on milestone 2; capabilities remain opt-in per request.

- [ ] Use one consistent configuration shape for each capability; reject unknown options.
- [ ] Add hosted web search with domain options, citations, and requested source lists.
- [ ] Add image/document/text attachments with trusted directory allowlists and byte limits.
- [ ] Resolve relative paths against an explicit working directory, then verify real paths remain allowed, including symlink cases.
- [ ] Define upload retention and cleanup; reject globs until deliberately implemented.

Gate: documented examples run through public MCP; disabled capabilities make no upload/search call; citations and source lists survive normalization; path escape/symlink/oversized/unsupported inputs fail before upload; partial uploads are reported and cleanup is tracked.

### Milestone 4 — Hosted Python and explicit artifact transfer

Depends on milestones 2–3.

- [ ] Add explicitly enabled hosted Python execution.
- [ ] Separate container selection, upload, execution, listing, and download operations.
- [ ] Respect caller-selected containers and report their lifecycle/status honestly.
- [ ] Download to a restricted artifact directory using generated local IDs and safe filenames.
- [ ] Handle pagination, transfer limits, hashes, collisions, expiry, and cleanup.

Gate: uploaded fixtures reach the selected container; generated files download without overwriting existing files; multiple same-name outputs remain distinct; expired containers produce an explicit outcome. No automatic two-way mirroring. A failed download cannot be reported as a successfully saved local artifact.

### Milestone 5 — Optional knowledge workflows

Requires a concrete use case and separate design approval.

- [ ] Decide whether vector stores add value beyond attachments/search.
- [ ] If justified, specify ingestion, attributes, chunking, pagination, expiration, and deletion before implementation.
- [ ] Revisit downstream MCP access only with explicit per-tool policies and approval semantics.
- [ ] Treat automatic file synchronization as a separate project with a conflict/deletion model and fault-injection tests.

### Release preparation

Applies before the first public release, then repeats per release.

- [x] Select a license and confirm the independent implementation boundary.
- [x] Decide whether to create a GitHub remote and whether it is public or private.
- [x] Configure CI for typecheck, lint, non-mutating formatting, build, coverage gates, and protocol/integration tests.
- [ ] Audit dependencies and document the applicability of unresolved advisories.
- [ ] Run an explicitly enabled live API smoke test with a small configured budget; never make it a default test requirement.
- [ ] Verify installation instructions and every documented example against the release build.
- [ ] Keep package, protocol metadata, tags, and changelog versions consistent.

## 9. Decisions before implementation

The directory/repository/specification can be created without these answers. Resolve these before choosing dependencies or freezing the first API:

1. **Client:** target the user's preferred MCP host first, then verify a second host for protocol portability.
2. **Default model:** configure explicitly through `OPENAI_MODEL`; choose the actual model with the user rather than embedding a moving alias in this document.
3. **Storage defaults:** choose the application data path, retention duration, and whether optional full transcripts are wanted.
4. **Limits:** select initial input/output/deadline/concurrency defaults using the intended workload and model constraints.
5. **Distribution:** personal local tool versus shared package; choose license and remote visibility before publishing.

The initial choices are recorded below; the next feature milestone is 3. This document authorizes no deployment, publishing, live API spending, or additional product integrations.

## 10. References and maintenance

- [OpenAI Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create)
- [OpenAI guidance on instruction continuity](https://developers.openai.com/api/docs/guides/migrate-to-responses#3-update-multi-turn-conversations)
- [MCP specification](https://modelcontextprotocol.io/specification)
- [Official MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)

The OpenAI instruction-continuity guidance was checked on 2026-10-30: `previous_response_id` does not carry forward top-level instructions, so stable instructions must be resent. Recheck current SDK/API contracts when implementing each capability. Reference links describe upstream contracts; unchecked roadmap items are proposed work, not claims of implemented support.

## 11. Implementation decisions (2026-10-30)

- Initial clients: official current MCP client plus a separate 2025-11-25 protocol client. Interactive host installation remains a user-specific setup step.
- Stack: strict TypeScript, official MCP v2 and OpenAI SDKs, Zod v4, and built-in Node SQLite. Node 22.23.2 is the development runtime. SDK automatic retries and content logging are explicitly disabled.
- Model: no embedded default. Resolve a per-call model, existing session default, or OPENAI_MODEL; otherwise return MODEL_REQUIRED. Model-specific combinations are validated by OpenAI and returned as safe errors.
- Claims: owner ID, lease deadline, and base revision live on requests; sessions retain their active request ID. Short BEGIN IMMEDIATE transactions reserve/finalize work; no network call runs inside a transaction. The lease lasts the total request deadline plus 30 seconds. Explicit abandonment or completed recovery fences old workers.
- Storage: platform application data path, private local directory, 30-day terminal result retention, 64 MiB live-content budget, 1000 sessions and 10000 request records. Sessions idle for the retention period with no unresolved request are deleted with their request history, so one-shot use cannot permanently exhaust the row limits. Assistant results and persistent instructions are stored; raw user prompts and per-call overrides are represented only by a caller-argument digest. Usage remains in a separate column when result content is pruned. Schema v2 migrates v1 usage data before pruning.
- Defaults: 120-second total deadline, 8192 output tokens, 256 KiB combined input, 256 KiB result envelope, four concurrent requests per state database. Full local transcripts are not implemented.
- Byte limits bound what the SDK buffers at once: each SSE event or a whole JSON body, at 8 × the result limit. A stream's total size is bounded by output tokens and the deadline; a cumulative stream cap would reject ordinary answers because each token arrives as its own event.
- Completed and refused responses advance the predecessor pointer; incomplete/failed/ambiguous requests do not. Missing/expired upstream history is never silently reset.
- A rejected creation (4xx other than 408) is definitive. A failed retrieval during recovery is definitive only for 404; rate-limit, authentication, and server errors leave the request recoverable. Errors expose OpenAI's code/param identifiers, never its free-text message.
- Tooling: pnpm with a pinned `packageManager` and strict engines; a Makefile is the front door (`make mcp-config` to install, `make check` for CI parity).
- Distribution: MIT-licensed public repository at github.com/joon-aca/simple-gpt-mcp on master. Not published to npm; `private: true` prevents accidental publication. No live API smoke test has been run.

Implemented tests use real SQLite, the actual MCP/OpenAI SDKs, a controlled loopback upstream, current and legacy protocol exchanges, and separate server processes. See README.md for commands and the implemented tool contract.
