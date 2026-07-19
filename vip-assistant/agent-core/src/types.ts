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

// ─── Identity ────────────────────────────────────────────────────────────────

export type SessionId = string & { readonly __brand: "SessionId" };
export type AgentId   = string & { readonly __brand: "AgentId" };
export type TaskId    = string & { readonly __brand: "TaskId" };
export type ToolUseId = string & { readonly __brand: "ToolUseId" };

// ─── Message primitives ───────────────────────────────────────────────────────

export type Role = "user" | "assistant" | "system";

export type TextBlock = { type: "text"; text: string };
export type ThinkingBlock = { type: "thinking"; thinking: string };
export type ToolUseBlock = {
  type: "tool_use";
  id: ToolUseId;
  name: string;
  input: Record<string, unknown>;
};
export type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: ToolUseId;
  content: string | ContentBlock[];
  is_error?: boolean;
};
export type ImageBlock = {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
};

export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | ToolUseBlock
  | ToolResultBlock
  | ImageBlock;

export type Message = {
  role: Role;
  content: ContentBlock[];
  metadata?: MessageMetadata;
};

export type MessageMetadata = {
  timestamp: number;
  sessionId?: SessionId;
  agentId?: AgentId;
  synthetic?: boolean;  // injected by compaction / system; not from user/model
};

// ─── Model usage / cost ───────────────────────────────────────────────────────

export type TokenUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

export type ModelUsage = TokenUsage & {
  model: string;
  cost_usd: number;
  duration_ms: number;
};

// ─── Tool system ──────────────────────────────────────────────────────────────

export type ToolInputSchema = {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
};

export type PermissionMode =
  | "default"         // asks when needed
  | "acceptEdits"     // auto-approves file writes
  | "bypassPermissions"; // auto-approves everything (headless / CI)

export type PermissionResult =
  | { granted: true }
  | { granted: false; reason: string };

export type ValidationResult =
  | { valid: true }
  | { valid: false; message: string; code: number };

/**
 * Runtime context injected into every tool call.
 * Mirrors ToolUseContext from the blueprint — tools should be stateless
 * and derive all runtime information from this object.
 */
export type ToolUseContext = {
  sessionId: SessionId;
  agentId?: AgentId;
  cwd: string;
  permissionMode: PermissionMode;
  abortSignal: AbortSignal;
  messages: Message[];          // full conversation history
  fileCache: FileStateCache;
  thinkingConfig: ThinkingConfig;
  verbose?: boolean;
};

export type FileStateCache = Map<string, { content: string; hash: string; mtime: number }>;

// ─── Thinking / reasoning ─────────────────────────────────────────────────────

export type ThinkingConfig =
  | { type: "disabled" }
  | { type: "enabled";  budgetTokens: number }
  | { type: "adaptive" }; // model decides dynamically

// ─── Task system ──────────────────────────────────────────────────────────────

export type TaskType =
  | "local_bash"
  | "local_agent"
  | "remote_agent"
  | "in_process_teammate"
  | "local_workflow"
  | "monitor_mcp"
  | "dream";   // background / speculative execution

export type TaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "killed";

export const TERMINAL_TASK_STATUSES: Set<TaskStatus> = new Set([
  "completed",
  "failed",
  "killed",
]);

export type TaskState = {
  id: TaskId;
  type: TaskType;
  status: TaskStatus;
  description: string;
  toolUseId?: ToolUseId;
  startTime: number;
  endTime?: number;
  totalPausedMs?: number;
  outputFile: string;
  outputOffset: number;
  notified: boolean;
  agentId?: AgentId;
};

// ─── MCP ──────────────────────────────────────────────────────────────────────

export type McpTransport = "stdio" | "sse" | "http" | "ws";

export type McpServerConfig = {
  name: string;
  transport: McpTransport;
  command?: string;         // stdio
  args?: string[];          // stdio
  url?: string;             // sse / http / ws
  env?: Record<string, string>;
};

export type McpServerConnection = McpServerConfig & {
  connected: boolean;
  capabilities: string[];
  tools: McpToolDescriptor[];
};

export type McpToolDescriptor = {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  serverId: string;
};

// ─── Query engine ─────────────────────────────────────────────────────────────

export type QueryEngineConfig = {
  cwd: string;
  tools: ToolRegistry;
  mcpClients: McpServerConnection[];
  permissionMode: PermissionMode;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  userSpecifiedModel?: string;
  thinkingConfig?: ThinkingConfig;
  maxTurns?: number;
  maxBudgetUsd?: number;
  verbose?: boolean;
  initialMessages?: Message[];
};

export type ToolRegistry = Map<string, ToolDefinition<unknown>>;

export type ToolDefinition<TInput> = {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  /** Validate input before execution. */
  validate?: (input: TInput, ctx: ToolUseContext) => ValidationResult | Promise<ValidationResult>;
  /** Check permissions. */
  checkPermission?: (input: TInput, ctx: ToolUseContext) => PermissionResult | Promise<PermissionResult>;
  /** Execute the tool. Yields progress, resolves to final content. */
  execute: (input: TInput, ctx: ToolUseContext) => AsyncGenerator<ToolProgressEvent, ToolResult>;
};

export type ToolProgressEvent = {
  type: "progress";
  data: unknown;
  label?: string;
};

export type ToolResult = {
  content: string | ContentBlock[];
  isError?: boolean;
  metadata?: Record<string, unknown>;
};

// ─── Query output stream ──────────────────────────────────────────────────────

export type QueryEvent =
  | { type: "message_start"; usage: TokenUsage }
  | { type: "content_block_start"; index: number; block: ContentBlock }
  | { type: "content_block_delta"; index: number; delta: string }
  | { type: "content_block_stop"; index: number }
  | { type: "tool_use_start"; toolUseId: ToolUseId; name: string }
  | { type: "tool_result"; toolUseId: ToolUseId; name?: string; result: ToolResult }
  | { type: "message_stop"; usage: TokenUsage; stopReason: StopReason }
  | { type: "error"; error: AgentError };

export type StopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "stop_sequence"
  | "budget_exceeded"
  | "permission_denied";

// ─── Error taxonomy ───────────────────────────────────────────────────────────

export type AgentErrorCode =
  | "TOOL_NOT_FOUND"
  | "TOOL_VALIDATION_FAILED"
  | "PERMISSION_DENIED"
  | "API_ERROR"
  | "API_RATE_LIMIT"
  | "CONTEXT_TOO_LONG"
  | "MAX_TURNS_EXCEEDED"
  | "BUDGET_EXCEEDED"
  | "ABORT"
  | "MCP_CONNECTION_FAILED"
  | "TASK_FAILED";

export type AgentError = {
  code: AgentErrorCode;
  message: string;
  retryable: boolean;
  details?: unknown;
};
