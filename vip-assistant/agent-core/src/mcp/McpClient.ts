/**
 * AGENT CORE — mcp/McpClient.ts
 *
 * Client for Model Context Protocol (MCP) servers.
 * Inferred from: src/services/mcp/, bridge/bridgeMain.ts,
 *                bridge/bridgeMessaging.ts, bridge/replBridge.ts
 *
 * The blueprint supports four transports:
 *   - stdio: spawn a local process and communicate over stdin/stdout
 *   - sse:   HTTP server-sent events (remote servers)
 *   - ws:    WebSocket (bidirectional remote)
 *   - http:  simple request/response (stateless remote)
 *
 * Each connected server exposes a set of tools. The engine converts those
 * into ToolDefinition objects and merges them into the main ToolRegistry.
 *
 * This implementation covers the stdio and HTTP transports which are
 * sufficient for local development and most hosted MCP servers.
 */

import { spawn, type ChildProcess } from "child_process";
import type {
  McpServerConfig,
  McpServerConnection,
  McpToolDescriptor,
  ToolDefinition,
  ToolUseContext,
} from "../types.js";

// ─── MCP JSON-RPC message types ───────────────────────────────────────────────

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: unknown;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string };
};

// ─── McpClient ────────────────────────────────────────────────────────────────

export class McpClient {
  private config: McpServerConfig;
  private process?: ChildProcess;
  private pendingRequests = new Map<
    string | number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private nextId = 1;
  private messageBuffer = "";
  private connected = false;
  private tools: McpToolDescriptor[] = [];

  constructor(config: McpServerConfig) {
    this.config = config;
  }

  // ── Connection lifecycle ──────────────────────────────────────────────────

  async connect(): Promise<McpServerConnection> {
    if (this.config.transport === "stdio") {
      await this.connectStdio();
    } else if (this.config.transport === "http") {
      await this.testHttpConnection();
    } else {
      throw new Error(`Transport not implemented: ${this.config.transport}`);
    }

    // Initialise the MCP session
    await this.sendRequest("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "agent-core", version: "1.0.0" },
    });

    await this.sendRequest("notifications/initialized", {});

    // Discover tools
    const toolsResult = await this.sendRequest("tools/list", {}) as {
      tools?: Array<{ name: string; description?: string; inputSchema?: unknown }>;
    };

    this.tools = (toolsResult.tools ?? []).map(t => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: (t.inputSchema ?? { type: "object", properties: {} }) as any,
      serverId: this.config.name,
    }));

    this.connected = true;

    return {
      ...this.config,
      connected: true,
      capabilities: ["tools"],
      tools: this.tools,
    };
  }

  async disconnect(): Promise<void> {
    if (this.process) {
      this.process.kill();
      this.process = undefined;
    }
    this.connected = false;
  }

  // ── Tool invocation ───────────────────────────────────────────────────────

  async callTool(
    toolName: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ content: string; isError: boolean }> {
    const result = await this.sendRequest("tools/call", {
      name: toolName,
      arguments: input,
    }, signal) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };

    const text = (result.content ?? [])
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text ?? "")
      .join("\n");

    return { content: text, isError: result.isError ?? false };
  }

  /**
   * Convert each MCP tool into a ToolDefinition for the main ToolRegistry.
   */
  toToolDefinitions(): ToolDefinition<Record<string, unknown>>[] {
    return this.tools.map(descriptor => this.wrapTool(descriptor));
  }

  // ── Private: stdio transport ──────────────────────────────────────────────

  private async connectStdio(): Promise<void> {
    if (!this.config.command) throw new Error("stdio transport requires command");

    this.process = spawn(this.config.command, this.config.args ?? [], {
      env: { ...process.env, ...(this.config.env ?? {}) },
      stdio: ["pipe", "pipe", "inherit"],
    });

    this.process.stdout!.on("data", (chunk: Buffer) => {
      this.messageBuffer += chunk.toString("utf8");
      this.processBuffer();
    });

    this.process.on("error", err => {
      this.rejectAllPending(err);
    });

    this.process.on("exit", () => {
      this.connected = false;
      this.rejectAllPending(new Error("MCP server process exited"));
    });
  }

  private processBuffer(): void {
    const lines = this.messageBuffer.split("\n");
    this.messageBuffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as JsonRpcResponse;
        const pending = this.pendingRequests.get(msg.id);
        if (!pending) continue;
        this.pendingRequests.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
        } else {
          pending.resolve(msg.result);
        }
      } catch {
        // Non-JSON line (e.g. log output from server) — ignore
      }
    }
  }

  // ── Private: HTTP transport ───────────────────────────────────────────────

  private async testHttpConnection(): Promise<void> {
    if (!this.config.url) throw new Error("HTTP transport requires url");
    const resp = await fetch(`${this.config.url}/health`).catch(() => null);
    if (!resp?.ok) {
      // Non-fatal — many servers don't have /health
    }
  }

  // ── Private: JSON-RPC ──────────────────────────────────────────────────────

  private sendRequest(
    method: string,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pendingRequests.set(id, { resolve, reject });

      const msg: JsonRpcRequest = {
        jsonrpc: "2.0",
        id,
        method,
        params,
      };

      if (signal?.aborted) {
        this.pendingRequests.delete(id);
        reject(new Error("Aborted"));
        return;
      }

      signal?.addEventListener("abort", () => {
        this.pendingRequests.delete(id);
        reject(new Error("Aborted"));
      });

      if (this.config.transport === "stdio") {
        this.process!.stdin!.write(JSON.stringify(msg) + "\n");
      } else {
        // HTTP: POST to /rpc
        fetch(`${this.config.url!}/rpc`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(msg),
          signal,
        })
          .then(r => r.json())
          .then((resp: JsonRpcResponse) => {
            this.pendingRequests.delete(id);
            if (resp.error) reject(new Error(resp.error.message));
            else resolve(resp.result);
          })
          .catch(err => {
            this.pendingRequests.delete(id);
            reject(err);
          });
      }
    });
  }

  private rejectAllPending(err: Error): void {
    for (const { reject } of this.pendingRequests.values()) {
      reject(err);
    }
    this.pendingRequests.clear();
  }

  // ── Tool wrapper ──────────────────────────────────────────────────────────

  private wrapTool(
    descriptor: McpToolDescriptor,
  ): ToolDefinition<Record<string, unknown>> {
    const client = this;
    return {
      name: `${descriptor.serverId}__${descriptor.name}`,
      description: `[${descriptor.serverId}] ${descriptor.description}`,
      inputSchema: descriptor.inputSchema,

      async *execute(input: Record<string, unknown>, ctx: ToolUseContext) {
        yield { type: "progress" as const, data: null, label: `${descriptor.serverId}: ${descriptor.name}` };
        const result = await client.callTool(descriptor.name, input, ctx.abortSignal);
        return result;
      },
    };
  }
}

// ─── MCP registry ─────────────────────────────────────────────────────────────

/**
 * Connect to all configured MCP servers and merge their tools into the registry.
 */
export async function connectMcpServers(
  configs: McpServerConfig[],
): Promise<{ connections: McpServerConnection[]; tools: ToolDefinition<unknown>[] }> {
  const connections: McpServerConnection[] = [];
  const tools: ToolDefinition<unknown>[] = [];

  await Promise.allSettled(
    configs.map(async config => {
      const client = new McpClient(config);
      try {
        const conn = await client.connect();
        connections.push(conn);
        tools.push(...client.toToolDefinitions() as ToolDefinition<unknown>[]);
      } catch (err) {
        console.error(`Failed to connect MCP server ${config.name}:`, err);
        connections.push({ ...config, connected: false, capabilities: [], tools: [] });
      }
    }),
  );

  return { connections, tools };
}
