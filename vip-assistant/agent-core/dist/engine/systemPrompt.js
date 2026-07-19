/**
 * AGENT CORE — engine/systemPrompt.ts
 *
 * Builds the system prompt sent to the model on every turn.
 * Inferred from: constants/prompts.ts, context.ts, utils/queryContext.ts,
 *                memdir/memdir.ts
 *
 * Structure (matches blueprint's getSystemPrompt + getUserContext pattern):
 *
 *   [ROLE DEFINITION]
 *   [TOOL CATALOGUE SUMMARY]          ← generated from registered tools
 *   [ENVIRONMENT CONTEXT]             ← cwd, OS, shell, date
 *   [MCP SERVERS]                     ← if any connected
 *   [MEMORY CONTENTS]                 ← if memory files present
 *   [CUSTOM SYSTEM PROMPT]            ← operator override (replaces default)
 *   [APPEND SYSTEM PROMPT]            ← operator addition (always appended)
 */
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
// ─────────────────────────────────────────────────────────────────────────────
export async function buildSystemPrompt(params) {
    const parts = [];
    if (params.customSystemPrompt) {
        // Operator-supplied prompt replaces the default entirely
        parts.push(params.customSystemPrompt);
    }
    else {
        parts.push(ROLE_DEFINITION);
        parts.push(buildToolSummary(params.tools));
        parts.push(await buildEnvironmentContext(params.cwd));
        if (params.mcpClients.length > 0) {
            parts.push(buildMcpSection(params.mcpClients));
        }
        const memory = await loadMemoryContents(params.cwd);
        if (memory) {
            parts.push(memory);
        }
    }
    if (params.appendSystemPrompt) {
        parts.push(params.appendSystemPrompt);
    }
    return parts.filter(Boolean).join("\n\n");
}
// ─── Role definition ──────────────────────────────────────────────────────────
const ROLE_DEFINITION = `\
You are an autonomous AI coding agent. You can read, write, and execute code
across a real filesystem and shell. You complete multi-step software engineering
tasks end-to-end with minimal user intervention.

Core operating principles:
- Always read before writing. Understand existing code before modifying it.
- Prefer targeted, minimal changes. Avoid rewriting files unnecessarily.
- When uncertain about intent, ask a clarifying question — do not guess.
- Verify results: after writing code, run it or test it to confirm correctness.
- Keep the user informed of progress on long tasks using concise status updates.
- Respect existing conventions: coding style, naming, directory layout.
- Greetings and Chatting: If the user message is a simple greeting (like "hi", "hello", "hey") or general conversational talk, answer directly in plain conversational English. Do NOT output JSON and do NOT call any tools.
- Tool Calls Constraint: Only call a tool when it is strictly required to fulfill the user's action request. Do NOT hallucinate or call tools that are not listed in the tool catalogue.
- JSON Formatting: If you do call a tool, format your tool call strictly using JSON with standard double quotes around keys and values. Do NOT use single quotes.

You have access to tools for file operations, shell execution, web search,
and external service integrations. Use the most appropriate tool for each step.
Prefer combining small precise actions over a single large speculative action.`;
// ─── Tool summary ─────────────────────────────────────────────────────────────
function buildToolSummary(tools) {
    if (tools.size === 0)
        return "";
    const lines = ["Available tools:"];
    for (const [name, tool] of tools) {
        lines.push(`  • ${name}: ${tool.description}`);
    }
    return lines.join("\n");
}
// ─── Environment context ──────────────────────────────────────────────────────
async function buildEnvironmentContext(cwd) {
    const platform = process.platform;
    const shell = process.env["SHELL"] ?? (platform === "win32" ? "powershell" : "bash");
    const now = new Date().toISOString();
    const lines = [
        "Environment:",
        `  Working directory: ${cwd}`,
        `  Platform: ${platform}`,
        `  Shell: ${shell}`,
        `  Date/time: ${now}`,
    ];
    // Include .gitignore hint if present
    if (existsSync(join(cwd, ".gitignore"))) {
        lines.push("  (A .gitignore is present — respect it when scanning files)");
    }
    return lines.join("\n");
}
// ─── MCP section ──────────────────────────────────────────────────────────────
function buildMcpSection(clients) {
    const lines = ["Connected MCP servers:"];
    for (const client of clients) {
        if (!client.connected)
            continue;
        lines.push(`  • ${client.name} (${client.transport})`);
        for (const tool of client.tools) {
            lines.push(`    - ${tool.name}: ${tool.description}`);
        }
    }
    return lines.join("\n");
}
// ─── Memory contents ──────────────────────────────────────────────────────────
/**
 * Loads CLAUDE.md memory files from the project directory.
 * Blueprint calls this "memdir" — it scans for CLAUDE.md files walking
 * upward from cwd, plus ~/.claude/CLAUDE.md for user-level memory.
 */
async function loadMemoryContents(cwd) {
    const candidates = [
        join(cwd, "CLAUDE.md"),
        join(process.env["HOME"] ?? "~", ".claude", "CLAUDE.md"),
    ];
    const contents = [];
    for (const path of candidates) {
        if (!existsSync(path))
            continue;
        try {
            const text = await readFile(path, "utf8");
            if (text.trim()) {
                contents.push(`<!-- Memory from ${path} -->\n${text.trim()}`);
            }
        }
        catch {
            // Non-fatal
        }
    }
    if (contents.length === 0)
        return null;
    return [
        "Memory / project context (loaded from CLAUDE.md files):",
        ...contents,
    ].join("\n\n");
}
