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

import { writeFile, appendFile, readFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";
import type { AgentId, TaskId, TaskState, TaskStatus, TaskType } from "../types.js";
import { TERMINAL_TASK_STATUSES } from "../types.js";

// ── ID generation ─────────────────────────────────────────────────────────────

const TASK_ID_PREFIX: Record<TaskType, string> = {
  local_bash: "b",
  local_agent: "a",
  remote_agent: "r",
  in_process_teammate: "t",
  local_workflow: "w",
  monitor_mcp: "m",
  dream: "d",
};

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

export function generateTaskId(type: TaskType): TaskId {
  const prefix = TASK_ID_PREFIX[type] ?? "x";
  const bytes = randomBytes(8);
  let id = prefix;
  for (let i = 0; i < 8; i++) {
    id += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return id as TaskId;
}

// ── TaskManager ───────────────────────────────────────────────────────────────

export class TaskManager {
  private tasks = new Map<TaskId, TaskState>();
  private abortControllers = new Map<TaskId, AbortController>();
  private outputDir: string;
  private listeners: Array<() => void> = [];

  constructor(outputDir: string = join(process.cwd(), ".claude", "tasks")) {
    this.outputDir = outputDir;
  }

  /**
   * Create a new task in "pending" state.
   */
  async create(
    type: TaskType,
    description: string,
    opts?: { toolUseId?: string; agentId?: AgentId },
  ): Promise<TaskState> {
    await mkdir(this.outputDir, { recursive: true });

    const id = generateTaskId(type);
    const outputFile = join(this.outputDir, `${id}.log`);

    const state: TaskState = {
      id,
      type,
      status: "pending",
      description,
      toolUseId: opts?.toolUseId as any,
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
  start(id: TaskId): AbortController {
    const state = this.requireTask(id);
    const ac = new AbortController();
    this.abortControllers.set(id, ac);
    this.update(id, { status: "running" });
    return ac;
  }

  /**
   * Mark task complete with final status.
   */
  finish(id: TaskId, status: "completed" | "failed"): void {
    this.update(id, { status, endTime: Date.now() });
    this.abortControllers.delete(id);
  }

  /**
   * Kill a running task — sends abort signal and marks as killed.
   */
  async kill(id: TaskId): Promise<void> {
    const state = this.tasks.get(id);
    if (!state) return;
    if (TERMINAL_TASK_STATUSES.has(state.status)) return;

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
  async appendOutput(id: TaskId, text: string): Promise<void> {
    const state = this.requireTask(id);
    await appendFile(state.outputFile, text, "utf8");
    const len = Buffer.byteLength(text, "utf8");
    this.update(id, { outputOffset: state.outputOffset + len });
  }

  /**
   * Read task output from a given byte offset.
   */
  async readOutput(id: TaskId, fromOffset = 0): Promise<string> {
    const state = this.requireTask(id);
    if (!existsSync(state.outputFile)) return "";
    const raw = await readFile(state.outputFile, "utf8");
    // Simple line-based offset — in production uses byte offsets
    return raw.slice(fromOffset);
  }

  get(id: TaskId): TaskState | undefined {
    return this.tasks.get(id);
  }

  list(filter?: { status?: TaskStatus; type?: TaskType }): TaskState[] {
    const all = Array.from(this.tasks.values());
    if (!filter) return all;
    return all.filter(t =>
      (filter.status == null || t.status === filter.status) &&
      (filter.type   == null || t.type   === filter.type),
    );
  }

  onUpdate(fn: () => void): () => void {
    this.listeners.push(fn);
    return () => { this.listeners = this.listeners.filter(l => l !== fn); };
  }

  private update(id: TaskId, patch: Partial<TaskState>): void {
    const prev = this.requireTask(id);
    if (TERMINAL_TASK_STATUSES.has(prev.status) && patch.status) {
      // Guard: no transitions out of terminal states
      return;
    }
    this.tasks.set(id, { ...prev, ...patch });
    this.notify();
  }

  private requireTask(id: TaskId): TaskState {
    const t = this.tasks.get(id);
    if (!t) throw new Error(`Task not found: ${id}`);
    return t;
  }

  private notify(): void {
    for (const fn of this.listeners) {
      try { fn(); } catch { /* non-fatal */ }
    }
  }
}
