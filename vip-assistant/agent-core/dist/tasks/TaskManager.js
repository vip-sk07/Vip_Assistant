/**
 * AGENT CORE — tasks/TaskManager.ts
 *
 * Lifecycle management for background tasks (bash, sub-agents, MCP monitors).
 * Inferred from: Task.ts, utils/tasks.ts, types/tasks in AppState
 *
 * Key characteristics from the blueprint:
 *  - Tasks are keyed by a type-prefixed ID (b*, a*, r*, t*, etc.)
 *  - Task output is streamed to disk (outputFile) and read back via offset
 *  - Terminal states: completed | failed | killed — no further transitions allowed
 *  - Signal-based kill: each task holds an AbortController
 *  - Team/multi-agent: tasks can be cross-linked to an agentId
 */
import { appendFile, readFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";
import { TERMINAL_TASK_STATUSES } from "../types.js";
// ── ID generation ─────────────────────────────────────────────────────────────
const TASK_ID_PREFIX = {
    local_bash: "b",
    local_agent: "a",
    remote_agent: "r",
    in_process_teammate: "t",
    local_workflow: "w",
    monitor_mcp: "m",
    dream: "d",
};
const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
export function generateTaskId(type) {
    const prefix = TASK_ID_PREFIX[type] ?? "x";
    const bytes = randomBytes(8);
    let id = prefix;
    for (let i = 0; i < 8; i++) {
        id += ALPHABET[bytes[i] % ALPHABET.length];
    }
    return id;
}
// ── TaskManager ───────────────────────────────────────────────────────────────
export class TaskManager {
    tasks = new Map();
    abortControllers = new Map();
    outputDir;
    listeners = [];
    constructor(outputDir = join(process.cwd(), ".claude", "tasks")) {
        this.outputDir = outputDir;
    }
    /**
     * Create a new task in "pending" state.
     */
    async create(type, description, opts) {
        await mkdir(this.outputDir, { recursive: true });
        const id = generateTaskId(type);
        const outputFile = join(this.outputDir, `${id}.log`);
        const state = {
            id,
            type,
            status: "pending",
            description,
            toolUseId: opts?.toolUseId,
            startTime: Date.now(),
            outputFile,
            outputOffset: 0,
            notified: false,
            agentId: opts?.agentId,
        };
        this.tasks.set(id, state);
        this.notify();
        return state;
    }
    /**
     * Transition a task to "running" and return its AbortController.
     */
    start(id) {
        const state = this.requireTask(id);
        const ac = new AbortController();
        this.abortControllers.set(id, ac);
        this.update(id, { status: "running" });
        return ac;
    }
    /**
     * Mark task complete with final status.
     */
    finish(id, status) {
        this.update(id, { status, endTime: Date.now() });
        this.abortControllers.delete(id);
    }
    /**
     * Kill a running task — sends abort signal and marks as killed.
     */
    async kill(id) {
        const state = this.tasks.get(id);
        if (!state)
            return;
        if (TERMINAL_TASK_STATUSES.has(state.status))
            return;
        const ac = this.abortControllers.get(id);
        if (ac) {
            ac.abort();
            this.abortControllers.delete(id);
        }
        this.update(id, { status: "killed", endTime: Date.now() });
    }
    /**
     * Append output to the task's log file.
     */
    async appendOutput(id, text) {
        const state = this.requireTask(id);
        await appendFile(state.outputFile, text, "utf8");
        const len = Buffer.byteLength(text, "utf8");
        this.update(id, { outputOffset: state.outputOffset + len });
    }
    /**
     * Read task output from a given byte offset.
     */
    async readOutput(id, fromOffset = 0) {
        const state = this.requireTask(id);
        if (!existsSync(state.outputFile))
            return "";
        const raw = await readFile(state.outputFile, "utf8");
        // Simple line-based offset — in production uses byte offsets
        return raw.slice(fromOffset);
    }
    get(id) {
        return this.tasks.get(id);
    }
    list(filter) {
        const all = Array.from(this.tasks.values());
        if (!filter)
            return all;
        return all.filter(t => (filter.status == null || t.status === filter.status) &&
            (filter.type == null || t.type === filter.type));
    }
    onUpdate(fn) {
        this.listeners.push(fn);
        return () => { this.listeners = this.listeners.filter(l => l !== fn); };
    }
    update(id, patch) {
        const prev = this.requireTask(id);
        if (TERMINAL_TASK_STATUSES.has(prev.status) && patch.status) {
            // Guard: no transitions out of terminal states
            return;
        }
        this.tasks.set(id, { ...prev, ...patch });
        this.notify();
    }
    requireTask(id) {
        const t = this.tasks.get(id);
        if (!t)
            throw new Error(`Task not found: ${id}`);
        return t;
    }
    notify() {
        for (const fn of this.listeners) {
            try {
                fn();
            }
            catch { /* non-fatal */ }
        }
    }
}
