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
export { BashTool, FileReadTool, FileWriteTool, FileEditTool, GlobTool, GrepTool, WebSearchTool, createDefaultToolRegistry, } from "./tools/builtins.js";
export { TaskManager, generateTaskId } from "./tasks/TaskManager.js";
export { McpClient, connectMcpServers } from "./mcp/McpClient.js";
export { Instrumentation, ConsoleTelemetryExporter, NoopTelemetryExporter, getInstrumentation, setInstrumentation, } from "./telemetry/instrumentation.js";
export { parseTokenBudget, findTokenBudgetPositions, getBudgetContinuationMessage, hasUltrathinkKeyword, } from "./utils/tokenBudget.js";
import { QueryEngine } from "./engine/QueryEngine.js";
import { createDefaultToolRegistry } from "./tools/builtins.js";
import { connectMcpServers } from "./mcp/McpClient.js";
/**
 * Create a fully configured agent instance.
 * Connects to MCP servers asynchronously before returning.
 */
export async function createAgent(options = {}) {
    const registry = options.disableBuiltinTools
        ? new Map()
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
        mcpClients: mcpConnections,
        permissionMode: options.permissionMode ?? "default",
        userSpecifiedModel: options.model,
        thinkingConfig: options.thinkingConfig ?? { type: "adaptive" },
        maxBudgetUsd: options.maxBudgetUsd,
        maxTurns: options.maxTurns,
        systemPrompt: options.systemPrompt,
        appendSystemPrompt: options.appendSystemPrompt,
    });
}
