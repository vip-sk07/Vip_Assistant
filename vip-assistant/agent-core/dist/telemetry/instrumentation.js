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
// ── ConsoleTelemetryExporter ──────────────────────────────────────────────────
export class ConsoleTelemetryExporter {
    emit(event) {
        if (process.env["AGENT_TELEMETRY_VERBOSE"]) {
            console.error(`[telemetry] ${event.kind}`, JSON.stringify(event));
        }
    }
}
// ── NoopTelemetryExporter ─────────────────────────────────────────────────────
export class NoopTelemetryExporter {
    emit(_event) { }
}
// ── Instrumentation ───────────────────────────────────────────────────────────
export class Instrumentation {
    exporters;
    sessionStartTime;
    constructor(exporters = [new NoopTelemetryExporter()]) {
        this.exporters = exporters;
        this.sessionStartTime = Date.now();
    }
    emit(event) {
        for (const exporter of this.exporters) {
            try {
                const result = exporter.emit(event);
                if (result instanceof Promise) {
                    result.catch(err => console.error("Telemetry export error:", err));
                }
            }
            catch (err) {
                // Telemetry must never throw
            }
        }
    }
    sessionStart(sessionId, model) {
        this.emit({ kind: "session.start", sessionId, model, timestamp: Date.now() });
    }
    sessionEnd(sessionId, totalCostUsd) {
        this.emit({
            kind: "session.end",
            sessionId,
            durationMs: Date.now() - this.sessionStartTime,
            totalCostUsd,
        });
    }
    turnStart(sessionId, turnIndex, model) {
        this.emit({ kind: "turn.start", sessionId, turnIndex, model });
    }
    turnEnd(sessionId, turnIndex, usage, durationMs) {
        this.emit({ kind: "turn.end", sessionId, turnIndex, usage, durationMs });
    }
    toolStart(sessionId, toolName, toolUseId) {
        this.emit({ kind: "tool.start", sessionId, toolName, toolUseId });
    }
    toolEnd(sessionId, toolName, toolUseId, durationMs, isError) {
        this.emit({ kind: "tool.end", sessionId, toolName, toolUseId, durationMs, isError });
    }
    costRecorded(sessionId, usage) {
        this.emit({ kind: "cost.recorded", sessionId, usage });
    }
    taskCreated(sessionId, task) {
        this.emit({
            kind: "task.created",
            sessionId,
            task: { id: task.id, type: task.type, description: task.description },
        });
    }
    taskTerminal(sessionId, task) {
        this.emit({
            kind: "task.terminal",
            sessionId,
            task: { id: task.id, status: task.status },
            durationMs: task.endTime ? task.endTime - task.startTime : 0,
        });
    }
    error(sessionId, error) {
        this.emit({ kind: "error", sessionId, error });
    }
}
// ── Singleton ─────────────────────────────────────────────────────────────────
let _instrumentation = null;
export function getInstrumentation() {
    if (!_instrumentation) {
        _instrumentation = new Instrumentation([new ConsoleTelemetryExporter()]);
    }
    return _instrumentation;
}
export function setInstrumentation(inst) {
    _instrumentation = inst;
}
