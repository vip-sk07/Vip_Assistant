/**
 * AGENT CORE — index.ts
 *
 * Public API surface for the agent-core package.
 *
 * Usage:
 *
 *   import { createAgent, BashTool, FileReadTool } from "agent-core";
 *
 *   const agent = createAgent({
 *     cwd: process.cwd(),
 *     tools: [BashTool, FileReadTool],
 *   });
 *
 *   for await (const event of agent.chat("Refactor src/utils.ts to use async/await")) {
 *     if (event.type === "content_block_delta") process.stdout.write(event.delta);
 *   }
 *
 *   console.log(`Cost: $${agent.totalCostUsd.toFixed(4)}`);
 */

export * from "./types.js";
export { QueryEngine } from "./engine/QueryEngine.js";
export { buildSystemPrompt } from "./engine/systemPrompt.js";
export { compactHistory } from "./engine/compaction.js";
export { callModel, costFromUsage, COST_PER_1K } from "./engine/modelClient.js";

export {
  BashTool,
  FileReadTool,
  FileWriteTool,
  FileEditTool,
  GlobTool,
  GrepTool,
  WebSearchTool,
  createDefaultToolRegistry,
} from "./tools/builtins.js";

export { TaskManager, generateTaskId } from "./tasks/TaskManager.js";
export { McpClient, connectMcpServers } from "./mcp/McpClient.js";
export {
  Instrumentation,
  ConsoleTelemetryExporter,
  NoopTelemetryExporter,
  getInstrumentation,
  setInstrumentation,
} from "./telemetry/instrumentation.js";
export {
  parseTokenBudget,
  findTokenBudgetPositions,
  getBudgetContinuationMessage,
  hasUltrathinkKeyword,
} from "./utils/tokenBudget.js";

// ── Convenience factory ───────────────────────────────────────────────────────

import type {
  McpServerConfig,
  PermissionMode,
  ThinkingConfig,
  ToolDefinition,
} from "./types.js";
import { QueryEngine } from "./engine/QueryEngine.js";
import { createDefaultToolRegistry } from "./tools/builtins.js";
import { connectMcpServers } from "./mcp/McpClient.js";

export type AgentOptions = {
  /** Working directory for file and shell operations. */
  cwd?: string;

  /** Additional tools to register (merged with built-ins). */
  tools?: ToolDefinition<unknown>[];

  /** Disable built-in tools if you want a fully custom set. */
  disableBuiltinTools?: boolean;

  /** MCP server configurations to connect at startup. */
  mcpServers?: McpServerConfig[];

  /** Override the model used for the main loop. */
  model?: string;

  /** Thinking / reasoning configuration. */
  thinkingConfig?: ThinkingConfig;

  /** Permission mode (default: "default"). */
  permissionMode?: PermissionMode;

  /** Hard cap on total API spend in USD. */
  maxBudgetUsd?: number;

  /** Maximum agentic loop turns before stopping. */
  maxTurns?: number;

  /** Custom system prompt (replaces the built-in role definition). */
  systemPrompt?: string;

  /** Text appended to the system prompt after the default. */
  appendSystemPrompt?: string;
};

/**
 * Create a fully configured agent instance.
 * Connects to MCP servers asynchronously before returning.
 */
export async function createAgent(options: AgentOptions = {}): Promise<QueryEngine> {
  const registry = options.disableBuiltinTools
    ? new Map<string, ToolDefinition<unknown>>()
    : createDefaultToolRegistry();

  // Register extra tools
  for (const tool of options.tools ?? []) {
    registry.set(tool.name, tool);
  }

  // Connect MCP servers
  let mcpConnections = [];
  if (options.mcpServers?.length) {
    const { connections, tools } = await connectMcpServers(options.mcpServers);
    mcpConnections = connections;
    for (const tool of tools) {
      registry.set(tool.name, tool);
    }
  }

  return new QueryEngine({
    cwd: options.cwd ?? process.cwd(),
    tools: registry,
    mcpClients: mcpConnections as any,
    permissionMode: options.permissionMode ?? "default",
    userSpecifiedModel: options.model,
    thinkingConfig: options.thinkingConfig ?? { type: "adaptive" },
    maxBudgetUsd: options.maxBudgetUsd,
    maxTurns: options.maxTurns,
    systemPrompt: options.systemPrompt,
    appendSystemPrompt: options.appendSystemPrompt,
  });
}
