# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```
npm start          # serve on http://127.0.0.1:4317
npm run open       # same, and opens the browser
```

```
npm test                                              # node --test, runs test/*.test.js
node --test --test-name-pattern="redact" test/projects.test.js   # a single test
```

Node 20+, no dependencies, no build step, no `npm install`. Tests use the built-in `node:test`; there is no linter. Env vars: `PORT`, `HOST` (default `127.0.0.1`), `CLAUDE_CONFIG_DIR` (default `~/.claude`), `CODEX_HOME` (default `~/.codex`), `OPENCLAW_STATE_DIR` (default `~/.openclaw`, or `~/.openclaw-<OPENCLAW_PROFILE>`). Hub and reporter flags map to `AGENT_HUB_*` env vars set by `bin/agent-hub.js` (`PORT=0` / `AGENT_HUB_INGEST_PORT=0` pick a free port; the server logs the real one).

Distribution: published to npm as `agent-hub-ui` and run with `npx agent-hub-ui` (or `npx github:UurDemir/agent-hub-ui`). `bin/agent-hub.js` is the CLI (`--port`, `--host`, `--no-open`, `--help`); it sets env vars and imports `server/index.js`. Only `bin/`, `server/` and `public/` ship (the `files` list in `package.json`) — a new runtime file anywhere else won't be in the package; check with `npm pack --dry-run`. `.gitattributes` forces LF so the CLI's shebang works on macOS/Linux. Releases: bump `version`, push, then publish a GitHub release tagged `v<version>`; `.github/workflows/publish.yml` runs the tests and `npm publish` through npm trusted publishing (no token; the package's Trusted Publisher on npmjs.com points at this repo and `publish.yml`, so renaming the workflow breaks publishing). CI (`ci.yml`) runs the tests and a packed-CLI smoke test on Linux, Windows and macOS, and builds the `Dockerfile` and starts it as a hub. The same release also runs `docker.yml`, which pushes the hub image to `ghcr.io/uurdemir/agent-hub-ui:<version>` and `:latest` (amd64 + arm64). The TrueNAS community app (`ix-dev/community/agent-hub` in `truenas/apps`) pins that version tag and configures the hub through env vars (`AGENT_HUB_MACHINES` instead of a keys file), so renaming those env vars breaks it.

The server must be restarted to pick up changes in `server/`; files in `public/` are served with `no-cache`, so a browser reload is enough.

Port 4317 is often already taken by a running dashboard instance. To test server changes, start a second instance on another port and query it:

```
PORT=4399 npm start
curl http://127.0.0.1:4399/api/agents          # live agents + other AI tools
curl http://127.0.0.1:4399/api/projects/user   # global ~/.claude setup
```

## Project constraints

- **Zero dependencies.** Server uses only `node:` built-ins (ESM, `"type": "module"`); frontend is plain browser JS with no bundler or framework.
- **Read-only.** The app reads Claude Code's and Codex's local state and never writes to `~/.claude`, `~/.claude.json`, `~/.codex`, `~/.openclaw` or project folders (OpenClaw's SQLite database is opened `readOnly`, and with `immutable=1` when no `-wal` file shows a gateway writing it, so SQLite doesn't create `-wal`/`-shm` files). The one way it acts on sessions is the opt-in `--allow-send` messaging (below). Keep that feature behind the flag, the one-use unlock codes and per-tab tokens, the Origin check, the anti-framing headers and the loopback-only rule in `server/index.js`. Never put a send token or unlock code in anything a GET returns (`/api/stream`, `/api/agents`): that would hand it to every local process.
- **Local-only.** It binds to `127.0.0.1` because transcripts contain code and prompts. Don't change the default host. `hostAllowed()` in `server/index.js` rejects requests whose `Host` header isn't the loopback address or an `--allowed-host` (DNS-rebinding protection); keep it in front of every new dashboard route. The only exceptions are opt-in hub mode (below): a reporter sends data only with `--report-to`, and a hub's network-facing ingest port only accepts keyed reports and serves nothing.
- **Multi-machine stays opt-in and minimal.** Everything a reporter sends and a hub keeps goes through the allowlists in `server/share.js`; a new agent or event field is private until listed there with its level. An agent whose `name` was made from a prompt sets `nameFromPrompt`, and `shareAgents()` replaces that name below `full` (prompts are `full`-only). Those functions also coerce types, because remote data ends up in the hub's HTML (numbers and class names are interpolated without `esc()`). The sharing level is chosen on the reporting machine (`--share`, default `metadata`) and the keys file can only lower it. Never let the hub ask for more, never relay `--allow-send` to remote machines or accept it from remote viewers (`refuseSend()` rejects `remoteViewer()` requests, and they get no send epoch), and keep the hub dashboard refusing a non-loopback bind without `--viewer-password`.
- **Secrets stay hidden.** Anything that surfaces MCP commands, hook commands, env vars, headers or URLs goes through `redact()` / `redactUrl()` in `server/projects.js`; only env/header *names* are sent, never values.
- **Path access is limited to known projects.** `/api/projects/<id>` only reads projects found in `~/.claude.json` or `~/.claude/projects/`; static serving rejects paths outside `public/`.
- **Cross-platform.** Windows and POSIX are both supported (see the `win32` branches in `server/processes.js` and `norm()` in `server/projects.js`).

## Claude tooling in this repo

- Hooks (`.claude/settings.json`): every Edit/Write of a JS file runs `node --check`; when Claude stops with uncommitted JS changes, `npm test` runs and failures send it back to work.
- Subagents: `transcript-drift-checker` (after a Claude Code update, or when activity looks wrong) and `privacy-auditor` (before committing changes to `server/` or `public/`).
- Skills: `verify-ui` (check the dashboard in a browser on port 4399) and `add-collector` (support another agent's logs; `server/codex.js` and `server/openclaw.js` are worked examples).

## Architecture

### Data flow

`server/index.js` wires five producers to one HTTP server. The three activity collectors are merged by `Sources` (`server/sources.js`), which is what the server and the reporter read (`snapshot()`, `allEvents()`, `'events'`, `'tick'`):

1. **`ClaudeCollector`** (`server/claude.js`) — polls on a 1s tick. Live sessions come from `~/.claude/sessions/<pid>.json` (alive check via `process.kill(pid, 0)`); recently ended sessions are found by transcript mtime (limits are constants at the top of the file). Each session tails its `~/.claude/projects/<slug>/<sessionId>.jsonl`, its `…/<sessionId>/subagents/agent-*.jsonl` (+ `.meta.json`), and `~/.claude/jobs/<jobId>/state.json` for background jobs. Emits `events` (new UI events for a key) and `tick`.
2. **`CodexCollector`** (`server/codex.js`) — same interface for OpenAI Codex CLI, from `$CODEX_HOME` (default `~/.codex`). Sessions are the rollout files `sessions/YYYY/MM/DD/rollout-<local time>-<threadId>.jsonl` (lines `{timestamp, ordinal?, type, payload}`; types `session_meta` (first line, read with `headLine()`), `turn_context`, `response_item`, `event_msg`, `compacted`). A session is live while `thread-writer-locks/<threadId>.lock` exists and a Codex process is seen (or the file was written in the last 2 minutes); a resumed session keeps writing to its old file, so locked ids are looked up in every date folder. Working = a turn is open (`task_started` without `task_complete` / `turn_aborted`). Prompts come from `user_message` (legacy rollouts) or `item_completed` `UserMessage` (paginated rollouts), not from `response_item` user messages, which also carry injected context. `reasoning` items are never shown. Tool calls are `function_call` / `custom_tool_call` (apply_patch) linked to `*_output` by `call_id`; MCP tools carry the server in `namespace` (`mcp__server__`). Subagents are separate rollouts whose `session_meta` names the root thread (`session_id` / `parent_thread_id`); they hang under it as `codex:<root>/<child>`. Internal threads (review, compaction, memory) are skipped. Keys are `codex:<threadId>`, `kind` is `'codex'` (the frontend's `toolKind()` / `TOOL_KINDS`), there is no cost, and the format was read from `github.com/openai/codex` (`codex-rs/protocol`, `codex-rs/rollout`), so check it there when Codex sessions look wrong. While a Codex session is live, Codex is dropped from the process list (`localOthers()`).
3. **`OpenClawCollector`** (`server/openclaw.js`) — same interface for the OpenClaw assistant gateway, from `$OPENCLAW_STATE_DIR` (default `~/.openclaw`), polled every 2s. Current OpenClaw: `agents/<agentId>/agent/openclaw-agent.sqlite`, tables `session_nodes` (one row per session key, `entry_json`, `current_session_id`, `parent_session_key`) and `transcript_events` (`session_id`, `seq`, `event_json` or zstd `event_zstd` + `event_utf8_bytes`); needs `node:sqlite` (Node 22.13+, imported lazily, so Node 20 keeps working) and `zlib.zstdDecompressSync` (22.15+). Up to 2026.7.x: `agents/<agentId>/sessions/sessions.json` + `<sessionId>.jsonl`. Both hold pi-format entries (`session` header with `cwd`, `message` with roles `user` / `assistant` (`text`, `thinking` — never shown, `toolCall`) / `toolResult` (`toolCallId`, `isError`), `model_change`, `session_info`, `compaction`). The gateway is up while a `tmp/openclaw*/gateway.*.lock` was touched in the last 90s (or an OpenClaw process is seen); a session is working while its last entry asks for more (user message, `stopReason: toolUse`, tool result) and is under 15 min old. Tool arguments go through `scrub()` (drops `env`, headers, tokens…). Keys are `openclaw:<sessionId>`, subagents `openclaw:<parent sessionId>/<child sessionId>` — never the session key, which names the chat contact or group and keys are shared at `metadata`; only a user-set `label` counts as a shareable name (display names, subjects, auto labels and `session_info` names are marked `nameFromPrompt`); `kind` is `'openclaw'`, cost comes from OpenClaw's own `usage.cost`. Format read from `github.com/openclaw/openclaw` (`src/state/openclaw-agent-schema.sql`, `src/config/sessions`, `packages/agent-core`).
4. **`ProcessScanner`** (`server/processes.js`) — every 10s lists OS processes (PowerShell `Get-CimInstance` on Windows, `ps` elsewhere) and matches them against the `AGENTS` table to detect other AI tools. Presence/memory/uptime only.
5. **`ProjectCatalog`** (`server/projects.js`) — on-demand (not streamed). Discovers projects and reads their Claude setup: CLAUDE.md, rules, agents, skills, commands, `.mcp.json`, settings/hooks/permissions, auto-memory, sessions, plugins. Usage counts come from regex scans over transcripts, cached by `size:mtime`.

Endpoints: `GET /api/stream` (SSE: `init` with full snapshot + last 200 events per key, then `agents`, `events`, `others`), `GET /api/agents`, `GET /api/projects`, `GET /api/projects/<id>` (`user` = global `~/.claude` setup), `POST /api/send/unlock` (`{code}` → `{token, epoch}`) and `POST /api/send` (`{key, text}` + `X-Agent-Hub-Token`), both only with `--allow-send`. The `agents` event is only broadcast when the JSON snapshot changes.

### Messaging sessions (`server/messaging.js`)

With `--allow-send` (env `AGENT_HUB_ALLOW_SEND=1`), `/api/send` delivers text to a live session through Claude Code's own cross-session messaging socket. The protocol is undocumented; it was read from the Claude Code 2.1.296 bundle:
- The session file's `messagingSocketPath` is a named pipe on Windows (`\\.\pipe\LOCAL\cc-msg-<32 hex>`) and a Unix socket elsewhere.
- The token is `peerToken` in `~/.claude/sessions/<pid>.<sha256(canonical socket path)>.key`. The canonical path is lowercased on Windows and `path.resolve`d elsewhere.
- Frames are newline-delimited JSON: `{"type":"auth","token"}`, then `{"type":"user","session_id","uuid","from":"agent-hub","message":{"role":"user","content"}}`. Claude Code drops a frame whose `session_id` doesn't match the session.
- The session receives it as a meta "message from another session". The transcript records it as an `attachment` of type `queued_command` with `origin: {kind: "peer", from}`. `parse.js` turns that into a `prompt` event with `from`, which the UI labels `YOU · HUB` or `SESSION`.

`canMessage` on an agent summary means the session is live and has a socket. How a tab gets a token:
- At startup the server makes a one-use unlock code. The CLI opens it as `<url>/#send=<code>`; with `--no-open` it prints it.
- `app.js` takes the code out of the hash, both on load and on `hashchange` (its listener runs before the router's). Once SSE `init` arrives, it trades the code at `/api/send/unlock`.
- The token is kept in `sessionStorage` (`hub.send`) together with the server run's `epoch`. SSE `init` carries only that epoch (`send`, `null` when sending is off); a saved token from another epoch is dropped.
- Each successful unlock prints a fresh link to the terminal.

`test/send.test.js` runs a real server and covers this flow.

### Hub and reporting (`server/hub.js`, `server/reporter.js`, `server/share.js`)

- **Reporter** (`--report-to <url>`): every ~1s POSTs gzipped JSON to `<url>/ingest` with `Authorization: Bearer <machine key>`: `{v, instance, seq, share, host, version}` plus either `init` (`agents`, `others`, `events` like SSE `init`) or the changes since the last post (`agents`, `others`, `events: [{key, events}]`), with a heartbeat every 5s. Data is filtered with `share.js` before it is sent. On any failure, or when the hub answers `needInit`, it drops its buffer and sends a fresh `init`. `ingestUrl()` refuses plain http off-machine without `--allow-http`. `--headless` starts no dashboard.
- **Hub** (`--hub --hub-keys <file>`): a second listener (`--ingest-port`, default `0.0.0.0:4318`, optional `--tls-cert/--tls-key`) with only `POST /ingest`. `Keyring` stores sha256 hashes, compares in constant time and re-reads the file on change (revocation). The machine name comes from the key entry, never from the report. `Hub.ingest()` requires `init` from an unknown instance or after a `seq` gap, refuses a second instance on the same key while the first is active (409), and re-applies `share.js` with `min(reported level, entry.share)`.
- Remote agent keys are `<machine>:<sessionId>` (subagents `<machine>:<sessionId>/<agentId>`, still split on `/` by the frontend); remote agents carry `machine`, `remote: true` and `share`. Local agents keep plain keys. A machine silent for 20s shows its agents as ended; it is dropped after 3h.
- SSE `init` also carries `machines` (`null` unless `--hub`; `@local` is this PC) and `reporting` (`null` unless `--report-to`); `machines` and `reporting` events update them. The frontend's machine filter only hides agents (`state.agents` vs `state.allAgents`); `byKey` keeps all of them so events aren't lost. Remote agents have no Projects page link; the canvas groups them per machine. `remoteViewer()` (a non-loopback bind, or a request through an `--allowed-host` name) gets 404 from `/api/projects*` and SSE `init.projects: false`, which hides the Projects tab: the hub PC's own CLAUDE.md, MCP and hook setup isn't covered by any sharing level.
- `test/remote.test.js` runs a real hub and a headless reporter against fake config dirs and checks that nothing above the sharing level reaches the hub.

### Transcript parsing (`server/parse.js`)

- `Tail` reads a growing JSONL file incrementally from a byte offset (starting `initialBytes` from the end, dropping the first partial line) and resets if the file shrinks.
- `Transcript.ingest(record)` turns one raw record into zero or more UI events — `prompt`, `say`, `tool`, `result`, `note`, `pr` — and keeps running state (model, context size, output tokens deduped by message id, todos from `TodoWrite`, PR links, branch, title, pending tool calls). `tool` and `result` events are linked by `toolId`; a result's `ms` comes from the pending tool's timestamp.
- `CATEGORY` / `toolCategory()` map tool names to the color categories used in the UI (`read`, `edit`, `run`, `web`, `agent`, `mcp`, `plan`, `ask`, `other`). New Claude Code tools land in `other` until added here; the same category list is mirrored in `public/app.js` (`CATS`) and as `--c-<cat>` CSS variables in `public/styles.css`.
- `activity()` produces the one-line "what is it doing now" for a card.

This file depends on Claude Code's undocumented transcript format (record `type`s like `ai-title`, `agent-name`, `last-prompt`, `pr-link`, `system`/`compact_boundary`; injected user text starting with `<` is skipped). When something shows up wrong in the UI, compare against a real transcript first.

To support another agent with local logs, write a collector like `server/claude.js`, `server/codex.js` or `server/openclaw.js` that emits the same event shape and add it to `Sources` in `server/index.js`.

### Keys and slugs

- An agent key is the `sessionId`; a subagent key is `<sessionId>/<agentId>`. The frontend relies on this split to attach subagents to their parent. In hub mode, remote keys get a `<machine>:` prefix (machine names can't contain `/` or `:`).
- Project folder names in `~/.claude/projects` are the cwd with every non-alphanumeric char replaced by `-`. This rule is implemented separately in `server/claude.js`, `server/projects.js` (`slug`), inline in `public/app.js` (link to the project page), and `projectIdOf` in `public/canvas.js` — keep them in sync.

### Frontend (`public/`)

- Three classic (non-module) scripts sharing globals, loaded in this order: `app.js` (SSE client, shared `state` and helpers, live view: swimlanes, agent cards, detail panel, notifications), `canvas.js` (`#/canvas` and `#/canvas/<project id>`: a node graph drawn on a `<canvas>` — stars, edges, hexagons, rings — under an HTML layer of labels, tool-call boxes and bubbles that shares the same camera; it runs a `requestAnimationFrame` loop only while the view is visible, rebuilds its layout model at most every 500 ms or on data change, and has a timeline that can scrub or replay by filtering events to a time `T`), and `projects.js` (`#/projects…` view and the hash router, which runs on load — so `canvas.js` must load before it). `app.js` calls `renderCanvas()`/`canvasActivity()` on SSE updates.
- Project grouping on the canvas uses the same cwd → folder-name slug as `~/.claude/projects` and folds Claude Code worktrees (`<repo>/.claude/worktrees/<name>`) into their repo.
- Costs (`cost` on agents and subagents) are estimates: `costRates()` in `server/parse.js` derives a USD-per-weighted-token rate per model from Claude Code's own `cost-state` records, and `transcriptCost()` applies it to each transcript's per-message usage. No prices are hard-coded; `cost` is `null` until some session has a `cost-state` record.
- Rendering is template strings into `innerHTML`. Every interpolated value must go through `esc()`, and links through `safeUrl()`. The small Markdown renderer in `projects.js` escapes its input before formatting.
- UI preferences persist in `localStorage` under the `hub.` prefix via `store`.
