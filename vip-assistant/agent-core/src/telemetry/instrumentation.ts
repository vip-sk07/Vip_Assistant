/**
 * AGENT CORE — telemetry/instrumentation.ts
 *
 * Lightweight telemetry layer.
 * Inferred from: utils/telemetry/instrumentation.ts, events.ts, sessionTracing.ts
 *
 * The blueprint uses OpenTelemetry under the hood (spans, meters, logs).
 * This implementation provides the same interface but with pluggable exporters
 * so it can work without a running OTEL collector.
 *
 * Events emitted:
 *   session.start / session.end
 *   turn.start / turn.end          (one per model call)
 *   tool.start / tool.end          (one per tool execution)
 *   cost.recorded                  (after each model call)
 *   task.created / task.terminal   (task lifecycle)
 *   error                          (any AgentError)
 */

import type { AgentError, ModelUsage, TaskState, TokenUsage } from "../types.js";

// ── Event types ───────────────────────────────────────────────────────────────

export type TelemetryEvent =
  | { kind: "session.start"; sessionId: string; model: string; timestamp: number }
  | { kind: "session.end";   sessionId: string; durationMs: number; totalCostUsd: number }
  | { kind: "turn.start";    sessionId: string; turnIndex: number; model: string }
  | { kind: "turn.end";      sessionId: string; turnIndex: number; usage: TokenUsage; durationMs: number }
  | { kind: "tool.start";    sessionId: string; toolName: string; toolUseId: string }
  | { kind: "tool.end";      sessionId: string; toolName: string; toolUseId: string; durationMs: number; isError: boolean }
  | { kind: "cost.recorded"; sessionId: string; usage: ModelUsage }
  | { kind: "task.created";  sessionId: string; task: Pick<TaskState, "id" | "type" | "description"> }
  | { kind: "task.terminal"; sessionId: string; task: Pick<TaskState, "id" | "status">; durationMs: number }
  | { kind: "error";         sessionId: string; error: AgentError };

export type TelemetryExporter = {
  emit(event: TelemetryEvent): void | Promise<void>;
};

// ── ConsoleTelemetryExporter ──────────────────────────────────────────────────

export class ConsoleTelemetryExporter implements TelemetryExporter {
  emit(event: TelemetryEvent): void {
    if (process.env["AGENT_TELEMETRY_VERBOSE"]) {
      console.error(`[telemetry] ${event.kind}`, JSON.stringify(event));
    }
  }
}

// ── NoopTelemetryExporter ─────────────────────────────────────────────────────

export class NoopTelemetryExporter implements TelemetryExporter {
  emit(_event: TelemetryEvent): void {}
}

// ── Instrumentation ───────────────────────────────────────────────────────────

export class Instrumentation {
  private exporters: TelemetryExporter[];
  private sessionStartTime: number;

  constructor(exporters: TelemetryExporter[] = [new NoopTelemetryExporter()]) {
    this.exporters = exporters;
    this.sessionStartTime = Date.now();
  }

  private emit(event: TelemetryEvent): void {
    for (const exporter of this.exporters) {
      try {
        const result = exporter.emit(event);
        if (result instanceof Promise) {
          result.catch(err => console.error("Telemetry export error:", err));
        }
      } catch (err) {
        // Telemetry must never throw
      }
    }
  }

  sessionStart(sessionId: string, model: string): void {
    this.emit({ kind: "session.start", sessionId, model, timestamp: Date.now() });
  }

  sessionEnd(sessionId: string, totalCostUsd: number): void {
    this.emit({
      kind: "session.end",
      sessionId,
      durationMs: Date.now() - this.sessionStartTime,
      totalCostUsd,
    });
  }

  turnStart(sessionId: string, turnIndex: number, model: string): void {
    this.emit({ kind: "turn.start", sessionId, turnIndex, model });
  }

  turnEnd(sessionId: string, turnIndex: number, usage: TokenUsage, durationMs: number): void {
    this.emit({ kind: "turn.end", sessionId, turnIndex, usage, durationMs });
  }

  toolStart(sessionId: string, toolName: string, toolUseId: string): void {
    this.emit({ kind: "tool.start", sessionId, toolName, toolUseId });
  }

  toolEnd(
    sessionId: string,
    toolName: string,
    toolUseId: string,
    durationMs: number,
    isError: boolean,
  ): void {
    this.emit({ kind: "tool.end", sessionId, toolName, toolUseId, durationMs, isError });
  }

  costRecorded(sessionId: string, usage: ModelUsage): void {
    this.emit({ kind: "cost.recorded", sessionId, usage });
  }

  taskCreated(sessionId: string, task: TaskState): void {
    this.emit({
      kind: "task.created",
      sessionId,
      task: { id: task.id, type: task.type, description: task.description },
    });
  }

  taskTerminal(sessionId: string, task: TaskState): void {
    this.emit({
      kind: "task.terminal",
      sessionId,
      task: { id: task.id, status: task.status },
      durationMs: task.endTime ? task.endTime - task.startTime : 0,
    });
  }

  error(sessionId: string, error: AgentError): void {
    this.emit({ kind: "error", sessionId, error });
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _instrumentation: Instrumentation | null = null;

export function getInstrumentation(): Instrumentation {
  if (!_instrumentation) {
    _instrumentation = new Instrumentation([new ConsoleTelemetryExporter()]);
  }
  return _instrumentation;
}

export function setInstrumentation(inst: Instrumentation): void {
  _instrumentation = inst;
}
