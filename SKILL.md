---
name: vip-assistant-dev
description: Use this skill whenever working on the VIP Assistant project (the local web-based AI agent platform with server.js, public/app.js, and the vendored agent-core engine). Trigger this for bug fixes, new features, provider/model switching logic, WebSocket protocol changes, telemetry/monitoring behavior, or any of the roadmap items (sandboxed terminal, code editor, RAG, agent logging, system monitor). Make sure to consult this before touching server.js, public/*, or proposing changes near agent-core.
---

# VIP Assistant Development Skill

Guidance for implementing fixes and new features on **VIP Assistant** — a local, self-hosted web UI that lets a user chat with an LLM-backed coding/ops agent, watch a live workspace, approve tool calls, and get proactive system health alerts.

## 1. Architecture map

```
vip-assistant/
├── server.js          ← YOUR code. Express + WebSocket server, agent orchestration, telemetry daemon.
├── public/
│   ├── index.html     ← YOUR code. UI shell, settings modal, chat/terminal panes.
│   ├── styles.css     ← YOUR code. Glassmorphism theme.
│   └── app.js          ← YOUR code. Client state, WS message handling, settings persistence.
├── agent-core/         ← EXTERNAL DEPENDENCY. Treat as a black box (see §2).
├── start.sh / setup-service.sh / autostart-vip.sh  ← deployment scripts.
└── package.json
```

**Message flow:** browser `app.js` ⇄ WebSocket ⇄ `server.js` ⇄ `agent-core.createAgent(...)` (async generator `agent.submitMessage()`) ⇄ chosen LLM provider (Gemini / Anthropic / local Ollama).

## 2. Hard rule: agent-core is a black box

`agent-core/` is a vendored, pre-built agent engine (`QueryEngine`, `toolDispatch`, `modelClient`, `compaction`, `systemPrompt`, `McpClient`). **Do not read, modify, patch, or reverse-engineer its internals** — not even to "just check" why something fails. This applies to the human developer and to any coding agent implementing this skill.

Instead:
- Treat it strictly through its **public surface**: `createAgent(options)`, `setPermissionPromptHandler(fn)`, `setToolProgressHandler(fn)`, `agent.submitMessage(text, signal)`, `agent.history`.
- If a bug seems to originate *inside* agent-core (not in how `server.js` calls it), the fix is to **change how you call it** (re-init timing, options passed, env vars set before the call) — never to edit its source.
- **Recommended mid-term move:** replace `agent-core` with a direct, documented API integration — call the Gemini API / Anthropic API / Ollama's REST API straight from `server.js` using the official SDKs already in `package.json` (`@google/generative-ai`, `@anthropic-ai/sdk`). This removes the black-box dependency entirely and is the first item in `advancement.md`. Prefer this over debugging around the vendored engine wherever the roadmap allows it.

## 3. Conventions to follow

**WebSocket protocol** — all messages are JSON with a `type` field. Client→server types currently include: `user_message`, `tool_approval`, `abort_generation`, `get_file_content`, `change_workspace`, `open_folder_picker`. Server→client types include: `init_workspace`, `assistant_chunk`, `tool_log`, `tool_request`, `terminal_start` / `terminal_output` / `terminal_end`, `status`, `loop_finished`, `error`, `anomaly_alert`, `workspace_changed`, `file_content`, `folder_picker_result`. **New features must add new `type` values following this same shape** — don't repurpose existing ones.

**Path safety** — any new filesystem feature (editor, RAG indexer, sandbox) MUST route through `resolveSafePath()` or an equivalent workspace-boundary check. Never let a WS message read/write/exec outside `WORKSPACE_DIR` without this check.

**Provider abstraction** — `settings.provider` is `'gemini' | 'anthropic' | 'ollama'`. API keys are read from `settings.apiKey` first, falling back to `.env` (`GEMINI_API_KEY` / `ANTHROPIC_API_KEY`). Ollama needs no key but requires `OLLAMA_HOST` (default `http://localhost:11434`) and a model that supports tool calling.

**Agent re-initialization** — a new `agentInstance` is only created when `currentModel` or `currentPermissionMode` changes (see `server.js` lines ~276-286). Any provider-switching bugfix should be verified against this exact condition — a stale `agentInstance` from a previous provider is the most likely cause of "agent replies with an error after switching LLM."

**Telemetry daemon** — polls every 10s (`startTelemetryDaemon`), checks RAM (>88%), CPU temp (>85°C), and `journalctl` priority-3 errors, with a 5-minute cooldown per alert type. Thresholds are hardcoded — any fix here should make them configurable rather than just raising the number, since "high but expected" varies by machine.

## 4. Before implementing any roadmap item

1. Check `advancement.md` for the specific item's acceptance criteria and constraints.
2. Confirm whether the feature needs new WS message types (§3) and add them to both `server.js` and `public/app.js` in the same change.
3. Confirm whether it touches the filesystem — if so, use `resolveSafePath()`.
4. Confirm whether it depends on agent-core's public surface only (§2) — if it seems to need something agent-core doesn't expose, that's a signal to solve it in `server.js`/a sidecar module instead of reaching into agent-core.
5. Test across all three providers (Gemini, Anthropic, Ollama) if the change touches the agent loop at all — provider parity bugs are the current #1 and #2 reported issues.
6. After changes, restart via `setup-service.sh` / the systemd user service rather than relying on a manually-launched `node server.js`, so behavior matches production.

## 5. Known open issues (see advancement.md §Bugs for detail)

- Switching LLM provider mid-session sometimes returns an agent error.
- Gemini provider fails even with a valid API key present.
- CPU temperature warnings fire during expected high-end-model load and should be smarter, not just louder or silent.
