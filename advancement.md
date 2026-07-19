# VIP Assistant — Advancement Plan

Companion document to the `vip-assistant-dev` skill. This file is the detailed spec: what's broken, what's being added, why, and how to know it's done. Implement in the order listed — later items build on earlier fixes (especially the provider-switch fix, which affects testing every feature after it).

---

## Part A — Bug Fixes (do these first)

### A1. Agent errors when switching LLM mid-session

**Symptom:** switching provider/model in Settings sometimes makes the next agent reply come back as an error.

**Likely cause:** `server.js` only creates a new `agentInstance` when `currentModel` or `currentPermissionMode` differs from the previous call (see SKILL.md §3). If a switch changes `settings.apiKey` or `settings.provider` without changing the *model string* itself (e.g. same model name reused across a key change, or a race between the WS message and env var assignment), the stale instance gets reused with mismatched credentials.

**Fix direction:**
- Include `provider` explicitly in the re-init comparison, not just `model` and `permissionMode`.
- Set `process.env.GEMINI_API_KEY` / `process.env.ANTHROPIC_API_KEY` **before** evaluating whether to re-create the agent, and always re-create when the provider changes, even if by coincidence the model name string matches.
- Add a try/catch around `createAgent()` that reports a clear WS `error` message identifying *which* provider/model failed to initialize, instead of surfacing a generic agent-loop error later.

**Acceptance criteria:** switching Gemini → Ollama → Anthropic → Gemini in one session, sending a message after each switch, never produces an error tied to stale state; each switch shows the "Initializing Agent Engine (...)" log line.

### A2. Gemini provider fails despite a valid API key

**Symptom:** Gemini calls fail even when the key is entered in Settings.

**Likely causes to check, in order:**
1. Key is being set on `process.env.GEMINI_API_KEY` *after* `createAgent()` has already read it into a closure (ordering bug — same root cause class as A1).
2. Selected Gemini model string (`gemini-1.5-flash`, `gemini-2.5-pro`, etc. — see `public/app.js` model list) is deprecated or mismatched with what the key's project has access to. `gemini-1.5-*` are marked "(Deprecated)" in your own UI — confirm the backend isn't silently defaulting to one of these regardless of UI selection.
3. Key format/whitespace: confirm the key from the Settings input is trimmed before being placed in `process.env`.

**Fix direction:** add an explicit startup self-test — on `createAgent()` failure for a `gemini` provider, immediately surface the raw provider error text (not a generic message) to the WS client so the actual HTTP/auth error is visible instead of guessed at.

**Acceptance criteria:** entering a valid Gemini key and selecting a non-deprecated model (2.5 Flash/Pro) completes a full round-trip chat reply; an invalid key produces a specific, readable error (not a silent failure or generic crash).

### A3. CPU temperature warnings during expected high-load model inference

**Symptom:** running a high-end local model correctly saturates the CPU/GPU and trips the `anomaly_alert` at 85°C, which is misleading — that's expected, not anomalous.

**Fix direction (config, not just a bigger number):**
- Add a **"model inference in progress" suppression window**: while `agentInstance` is actively streaming (between `runAgentLoop` start and `loop_finished`/`error`), skip temperature alerting entirely, or raise the threshold contextually (e.g. 92°C) only during that window.
- Make the base threshold a Settings-configurable value (`tempAlertThreshold`, default 85) instead of hardcoded, so it can be tuned per machine.
- Keep RAM and journal checks unaffected — those are still meaningful during inference.

**Acceptance criteria:** running a local 7B+ model via Ollama under sustained load does not trigger `anomaly_alert` for `temp` while the agent is actively generating; idle-time overheating (e.g. from an unrelated runaway process) still alerts correctly.

---

## Part B — New Features (roadmap)

### B1. `gemini.html` — GenAI-powered OS monitor page

A dedicated page/panel (separate from the main chat) that uses a Gemini API call to narrate/interpret the telemetry the daemon already collects (`ramPercent`, `cpuTemp`, `journalError`), turning raw numbers into a plain-language system status ("Memory is fine, temp is elevated but expected given active inference, no service failures").

- Reuse the existing `querySystemTelemetry()` output — add a new WS message type (e.g. `telemetry_snapshot`, sent on demand or on an interval) rather than duplicating the polling logic.
- The Gemini call here is a *summarization* call, separate from the main agent loop — it should not go through `agent-core` at all; call `@google/generative-ai` directly for this narrow purpose, since it's a single-turn, tool-free request.
- **Acceptance criteria:** opening the monitor page shows a live, plain-English system status that updates on the same cadence as the telemetry daemon, without needing a running agent conversation.

### B2. Sandboxed terminal execution

Currently, `Bash` tool calls stream straight to `terminal_output` with only workspace-path checks (`resolveSafePath`) — command execution itself isn't sandboxed.

- Introduce an execution boundary (container, restricted user, or `firejail`/namespaces-based sandbox — pick based on what's available on the host OS) between the agent's `Bash` tool calls and the real shell.
- Keep the existing permission-prompt flow (`setPermissionPromptHandler`) as the first gate; the sandbox is the second, defense-in-depth layer — it should not replace user approval.
- Resource-limit the sandbox (memory/CPU caps, no network by default, restricted filesystem view scoped to `WORKSPACE_DIR`).
- **Acceptance criteria:** a destructive or out-of-workspace command (e.g. `rm -rf /`, network exfiltration attempt) is contained/blocked by the sandbox even if mistakenly approved; normal in-workspace dev commands (`npm install`, `git status`, running tests) still work.

### B3. Code editor with click-to-open (Windsurf-style)

When a file is clicked in the workspace file list, open it in an inline editor pane rather than only supporting the existing `get_file_content` read-only flow.

- Extend `get_file_content` response handling in `app.js` to route into an editor component (e.g. CodeMirror or Monaco) instead of a plain viewer.
- Add a new WS type `save_file_content` (mirroring `get_file_content`) that writes back through `resolveSafePath()` — never allow direct writes from the editor to bypass the workspace boundary.
- Reflect external changes: the existing `chokidar` watcher already emits `workspace_changed` — wire that into the editor to prompt "file changed on disk, reload?" instead of silently overwriting.
- **Acceptance criteria:** click a file → it opens editable → save writes it back safely → an external edit (e.g. from the agent's own tool calls) triggers a reload prompt instead of a silent conflict.

### B4. RAG for contextual grounding

Give the agent retrieval access to project-specific context (docs, past conversation history, workspace file summaries) beyond what fits in the prompt window.

- Index workspace files (respecting the same ignore patterns as the `chokidar` watcher: dotfiles, `node_modules`) into embeddings, stored locally (e.g. a lightweight local vector store — sqlite-vec or similar — no need for a hosted vector DB for a local-first tool).
- Expose retrieval as a **tool the agent can call**, not as an always-on prompt injection — this keeps token usage predictable and matches the existing tool-call architecture (`tool_use_start`/`tool_result` already handled in `runAgentLoop`).
- Re-index incrementally on `workspace_changed` events rather than full re-scans each time.
- **Acceptance criteria:** asking a question that requires knowledge of a file not currently open/attached gets a grounded answer citing the retrieved snippet, without manually pasting the file into chat.

### B5. Logging surfaced to the agent

Currently, system/service logs are only used internally (`journalctl` check in telemetry) and tool progress logs go straight to the UI (`tool_log` messages) — the agent itself doesn't have structured access to its own run history or system logs as reviewable context.

- Add a log-retrieval tool (agent-invocable) that lets the agent request recent `journalctl` output, its own past tool-call results, or WS session history on demand — rather than only reacting to the proactive `anomaly_alert` push.
- Persist a rolling session log (tool calls + results + telemetry snapshots) to disk per session so the agent (or the user) can review "what happened" after the fact, not just live-stream it.
- **Acceptance criteria:** the agent can be asked "what happened in the last 10 minutes" and answer using its own tool-call/telemetry history, not just guess from chat context.

---

## Suggested implementation order

1. A1 → A2 (fix provider switching before testing anything else against multiple providers)
2. A3 (removes noisy false alarms while you do heavier testing in B2/B4)
3. B5 (logging) — do this before B2/B4 so you have observability while building the riskier features
4. B3 (editor) and B1 (monitor page) — lower risk, high visible value
5. B2 (sandbox) — security-sensitive, take the most care here
6. B4 (RAG) — most complex, benefits from everything above already being stable
