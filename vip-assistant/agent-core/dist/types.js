/**
 * AGENT CORE — types.ts
 * Central type definitions inferred from client-side blueprint analysis.
 *
 * Architecture assumptions:
 *  - The agent is message-passing: every interaction is a stream of SDKMessages
 *  - Tools are the primary capability extension mechanism
 *  - Tasks represent async side-effects (bash, agent spawning, MCP calls)
 *  - Permission gates wrap every tool invocation
 *  - Thinking/reasoning tokens are first-class budget citizens
 */
export const TERMINAL_TASK_STATUSES = new Set([
    "completed",
    "failed",
    "killed",
]);
