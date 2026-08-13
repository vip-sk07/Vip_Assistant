/**
 * AGENT CORE — engine/QueryEngine.ts
 *
 * The central agentic loop. Derived by reverse-engineering the architecture of
 * the client-side blueprint (QueryEngine.ts, query.ts, queryHelpers.ts,
 * queryContext.ts).
 *
 * Key design decisions inferred from the blueprint:
 *
 *  1. The loop is a async generator — every turn yields a stream of QueryEvents
 *     so the caller can render incremental output.
 *
 *  2. Tools are registered externally and injected via QueryEngineConfig.
 *     The engine does NOT hard-code tool logic — it only drives tool dispatch,
 *     permission checks, and result injection.
 *
 *  3. Compaction: when the context grows beyond a threshold the engine compacts
 *     history using a summarisation call, preserving semantic continuity.
 *
 *  4. Thinking tokens: when ThinkingConfig is 'enabled' or 'adaptive', the
 *     engine adds a beta header and processes <thinking> blocks separately from
 *     the user-visible content stream.
 *
 *  5. Budget guard: before each turn the engine checks accumulated cost against
 *     maxBudgetUsd and emits budget_exceeded if crossed.
 *
 *  6. Permission gate: tool inputs are sent through checkPermission() before
 *     any execution; denials are returned as tool_result is_error blocks so the
 *     model can respond gracefully.
 */

import type {
  AgentError,
  ContentBlock,
  Message,
  ModelUsage,
  PermissionMode,
  QueryEngineConfig,
  QueryEvent,
  StopReason,
  ThinkingConfig,
  TokenUsage,
  ToolDefinition,
  ToolResult,
  ToolUseBlock,
  ToolUseContext,
  ToolUseId,
} from "../types.js";
import { buildSystemPrompt } from "./systemPrompt.js";
import { compactHistory } from "./compaction.js";
import { callModel } from "./modelClient.js";
import { dispatchTool } from "./toolDispatch.js";
import { costFromUsage, COST_PER_1K } from "./modelClient.js";
import { resolve, isAbsolute } from "path";
import { existsSync } from "fs";
import { readFile, writeFile } from "fs/promises";

// ── Constants ────────────────────────────────────────────────────────────────

/** Tokens at which we trigger compaction (mirrors ~200k threshold in blueprint). */
const COMPACT_THRESHOLD_TOKENS = 180_000;

/** Maximum consecutive tool-call turns before we stop to avoid infinite loops. */
const DEFAULT_MAX_TURNS = 50;

// ── QueryEngine class ─────────────────────────────────────────────────────────

export class QueryEngine {
  private config: QueryEngineConfig;
  private messages: Message[];
  private accumulatedUsage: TokenUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
  private accumulatedCostUsd = 0;
  private turnCount = 0;

  constructor(config: QueryEngineConfig) {
    this.config = config;
    this.messages = config.initialMessages ? [...config.initialMessages] : [];
  }

  /**
   * Submit a new user message and run the agentic loop until the model stops
   * (end_turn), hits a hard limit, or the abort signal fires.
   *
   * Yields QueryEvents for incremental rendering.
   */
  async *submitMessage(
    userContent: string | ContentBlock[],
    signal: AbortSignal,
  ): AsyncGenerator<QueryEvent> {
    // 1. Append the user message
    this.messages.push({
      role: "user",
      content: typeof userContent === "string" ? [{ type: "text", text: userContent }] : userContent,
      metadata: { timestamp: Date.now() },
    });

    yield* this.runLoop(signal);
  }

  // ── Core agentic loop ────────────────────────────────────────────────────

  private async *runLoop(signal: AbortSignal): AsyncGenerator<QueryEvent> {
    const maxTurns = this.config.maxTurns ?? DEFAULT_MAX_TURNS;

    while (this.turnCount < maxTurns) {
      if (signal.aborted) {
        yield this.errorEvent("ABORT", "Aborted by user", false);
        return;
      }

      // Budget check
      if (this.config.maxBudgetUsd !== undefined &&
          this.accumulatedCostUsd >= this.config.maxBudgetUsd) {
        yield this.errorEvent("BUDGET_EXCEEDED",
          `Cost $${this.accumulatedCostUsd.toFixed(4)} reached limit $${this.config.maxBudgetUsd}`,
          false,
        );
        return;
      }

      // Compaction: if history is getting large, compress it
      const estimatedTokens = estimateTokens(this.messages);
      if (estimatedTokens > COMPACT_THRESHOLD_TOKENS) {
        this.messages = await compactHistory(this.messages, {
          model: this.resolveModel(),
          systemPrompt: await this.buildSystemPrompt(),
          signal,
        });
      }

      // Build the API params
      const systemPrompt = await this.buildSystemPrompt();
      const thinkingConfig = this.resolveThinkingConfig();
      const model = this.resolveModel();

      // ── Call the model ─────────────────────────────────────────────────
      let assistantContent: ContentBlock[] = [];
      let usage: TokenUsage = { input_tokens: 0, output_tokens: 0 };
      let stopReason: StopReason = "end_turn";

      try {
        for await (const event of callModel({
          model,
          system: systemPrompt,
          messages: this.messages,
          tools: this.buildApiToolList(),
          thinkingConfig,
          signal,
        })) {
          yield event;

          if (event.type === "message_stop") {
            usage = event.usage;
            stopReason = event.stopReason;
            assistantContent = (event as any).content || [];
          }
          // Collect final content from streamed events
          if (event.type === "content_block_stop") {
            // content accumulated by caller via deltas — handled below
          }
        }
      } catch (err) {
        yield this.handleApiError(err);
        return;
      }

      console.log(`[QueryEngine] callModel loop finished. stopReason: ${stopReason}`);
      console.log(`[QueryEngine] assistantContent:`, JSON.stringify(assistantContent));

      // Accrue usage & cost
      this.accumulateUsage(usage, model);

      // Append assistant message
      this.messages.push({
        role: "assistant",
        content: assistantContent,
        metadata: { timestamp: Date.now() },
      });

      this.turnCount++;

      // ── End conditions ────────────────────────────────────────────────
      if (stopReason === "end_turn" || stopReason === "stop_sequence") {
        return;
      }

      if (stopReason === "max_tokens") {
        // Continue automatically — model was cut off
        this.messages.push({
          role: "user",
          content: [{ type: "text", text: "Continue." }],
          metadata: { timestamp: Date.now(), synthetic: true },
        });
        continue;
      }

      console.log(`[QueryEngine] stopReason validation: stopReason=${stopReason}`);
      if (stopReason !== "tool_use") {
        console.log(`[QueryEngine] Exiting loop because stopReason is not tool_use (${stopReason})`);
        return;
      }

      // ── Tool dispatch ─────────────────────────────────────────────────
      const toolUseBlocks = assistantContent.filter(
        (b): b is ToolUseBlock => b.type === "tool_use"
      );

      console.log(`[QueryEngine] toolUseBlocks count: ${toolUseBlocks.length}`);
      if (toolUseBlocks.length === 0) {
        console.log(`[QueryEngine] Exiting loop because toolUseBlocks is empty`);
        return;
      }

      const toolResultContent: ContentBlock[] = [];

      for (const toolUse of toolUseBlocks) {
        console.log(`[QueryEngine] Dispatching tool: name=${toolUse.name}, id=${toolUse.id}`);
        yield { type: "tool_use_start", toolUseId: toolUse.id, name: toolUse.name };

        const ctx: ToolUseContext = {
          sessionId: this.config as any, // injected externally in production
          cwd: this.config.cwd,
          permissionMode: this.config.permissionMode ?? "default",
          abortSignal: signal,
          messages: this.messages,
          fileCache: new Map(),
          thinkingConfig: this.resolveThinkingConfig(),
          verbose: this.config.verbose,
        };

        console.log(`[QueryEngine] Running tool execution for ${toolUse.name} with input:`, JSON.stringify(toolUse.input));
        let result = await this.executeToolWithPermissions(toolUse, ctx);
        console.log(`[QueryEngine] Tool execution resolved. isError: ${result.isError}`);

        // Self-Healing Terminal & Test Runner (Advancement 1 & Idea 1)
        if (toolUse.name === "Bash" && result.isError) {
          try {
            // First attempt to resolve missing dependencies (fast regex check, no LLM call needed)
            const depHealed = await this.attemptDependencySelfHealing(toolUse, result, ctx);
            if (depHealed) {
              result = depHealed;
            } else {
              // Fallback to code self-healing (requires LLM call)
              const healedResult = await this.attemptSelfHealing(toolUse, result, ctx);
              if (healedResult) {
                result = healedResult;
              }
            }
          } catch (e) {
            if (ctx.verbose) {
              console.error("Self-healing failed:", e);
            }
          }
        }

        yield { type: "tool_result", toolUseId: toolUse.id, name: toolUse.name, result };

        toolResultContent.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: result.content,
          is_error: result.isError,
        });
      }

      // Inject tool results as a user message
      this.messages.push({
        role: "user",
        content: toolResultContent,
        metadata: { timestamp: Date.now(), synthetic: true },
      });
    }

    // Fell out of the while loop
    yield this.errorEvent("API_ERROR", `Max turns (${maxTurns}) exceeded`, false);
  }

  // ── Tool execution with permission gate ──────────────────────────────────

  private async executeToolWithPermissions(
    toolUse: ToolUseBlock,
    ctx: ToolUseContext,
  ): Promise<ToolResult> {
    const tool = this.config.tools.get(toolUse.name) as ToolDefinition<unknown> | undefined;

    if (!tool) {
      return {
        content: `Tool not found: ${toolUse.name}`,
        isError: true,
      };
    }

    // Validate input
    if (tool.validate) {
      const v = await tool.validate(toolUse.input, ctx) as any;
      if (!v.valid) {
        return { content: `Validation failed: ${v.message}`, isError: true };
      }
    }

    // Permission gate
    if (tool.checkPermission && ctx.permissionMode !== "bypassPermissions") {
      const p = await tool.checkPermission(toolUse.input, ctx) as any;
      if (!p.granted) {
        return { content: `Permission denied: ${p.reason}`, isError: true };
      }
    }

    // Execute (drain progress events)
    try {
      return await dispatchTool(tool, toolUse.input, ctx);
    } catch (err) {
      return {
        content: `Tool execution error: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async buildSystemPrompt(): Promise<string> {
    return buildSystemPrompt({
      tools: this.config.tools,
      customSystemPrompt: this.config.systemPrompt,
      appendSystemPrompt: this.config.appendSystemPrompt,
      mcpClients: this.config.mcpClients,
      cwd: this.config.cwd,
    });
  }

  private resolveModel(): string {
    return this.config.userSpecifiedModel ?? "claude-sonnet-4-5";
  }

  private resolveThinkingConfig(): ThinkingConfig {
    return this.config.thinkingConfig ?? { type: "adaptive" };
  }

  private buildApiToolList() {
    const tools: Array<{ name: string; description: string; input_schema: unknown }> = [];
    for (const [name, tool] of this.config.tools) {
      tools.push({
        name,
        description: tool.description,
        input_schema: tool.inputSchema,
      });
    }
    return tools;
  }

  private accumulateUsage(usage: TokenUsage, model: string) {
    this.accumulatedUsage.input_tokens += usage.input_tokens;
    this.accumulatedUsage.output_tokens += usage.output_tokens;
    this.accumulatedCostUsd += costFromUsage(usage, model);
  }

  private handleApiError(err: unknown): QueryEvent {
    const msg = err instanceof Error ? err.message : String(err);
    const code = msg.includes("rate") ? "API_RATE_LIMIT" : "API_ERROR";
    const retryable = code === "API_RATE_LIMIT";
    return this.errorEvent(code, msg, retryable);
  }

  private errorEvent(
    code: AgentError["code"],
    message: string,
    retryable: boolean,
  ): QueryEvent {
    return {
      type: "error",
      error: { code, message, retryable },
    };
  }

  // ── Public accessors ──────────────────────────────────────────────────────

  get totalCostUsd(): number { return this.accumulatedCostUsd; }
  get totalUsage(): TokenUsage { return { ...this.accumulatedUsage }; }
  get history(): Message[] { return [...this.messages]; }

  private async attemptSelfHealing(
    toolUse: ToolUseBlock,
    result: ToolResult,
    ctx: ToolUseContext
  ): Promise<ToolResult | null> {
    const errorOutput = typeof result.content === "string" ? result.content : "";
    const loc = parseErrorLocation(errorOutput);
    if (!loc) return null;

    let absPath = loc.file;
    if (!isAbsolute(absPath)) {
      absPath = resolve(ctx.cwd, absPath);
    }

    if (!existsSync(absPath)) {
      return null;
    }

    let fileContent = "";
    try {
      fileContent = await readFile(absPath, "utf8");
    } catch {
      return null;
    }

    const lines = fileContent.split("\n");
    const errLineIdx = loc.line - 1;
    if (errLineIdx < 0 || errLineIdx >= lines.length) {
      return null;
    }

    const startIdx = Math.max(0, errLineIdx - 15);
    const endIdx = Math.min(lines.length, errLineIdx + 15);
    const snippetLines = lines.slice(startIdx, endIdx);
    const numberedSnippet = snippetLines
      .map((l, i) => `${String(startIdx + i + 1).padStart(6)}\t${l}`)
      .join("\n");

    const systemPrompt = "You are an expert software engineer assistant specializing in self-healing code. Your task is to analyze a compilation or runtime crash, inspect the surrounding source code, and provide a code correction to resolve the issue.";
    
    const userPrompt = `A terminal command failed in the workspace.
Command: ${toolUse.input.command}
Error Output:
${errorOutput}

The crash occurred in file ${loc.file} at line ${loc.line}.
Here is the surrounding code from ${loc.file} (lines ${startIdx + 1} to ${endIdx}):
\`\`\`
${numberedSnippet}
\`\`\`

Analyze the error and write a replacement for the broken code block.
Your response MUST be a valid JSON object matching the schema below. Do NOT write any conversational text, explanations, or code blocks outside the JSON.

JSON Schema:
{
  "explanation": "Brief explanation of the bug and fix",
  "old_string": "The exact block of code from the snippet that needs to be replaced. Must contain precisely the lines of code to replace (preserving spaces and indentation).",
  "new_string": "The new corrected block of code to replace the old_string with."
}

Generate the JSON response:`;

    try {
      const responseText = await getLlmCompletion(this.resolveModel(), systemPrompt, userPrompt, ctx.abortSignal);
      
      const jsonStart = responseText.indexOf("{");
      const jsonEnd = responseText.lastIndexOf("}");
      if (jsonStart === -1 || jsonEnd === -1) {
        return null;
      }
      const jsonStr = responseText.slice(jsonStart, jsonEnd + 1);
      const repairInfo = JSON.parse(jsonStr);

      if (!repairInfo.old_string || repairInfo.new_string === undefined) {
        return null;
      }

      if (!fileContent.includes(repairInfo.old_string)) {
        return null;
      }

      const updatedContent = fileContent.replace(repairInfo.old_string, repairInfo.new_string);
      await writeFile(absPath, updatedContent, "utf8");

      console.log(`[Self-Healing] Patched ${loc.file} successfully to resolve line ${loc.line}!`);
      
      const retriedResult = await this.executeToolWithPermissions(toolUse, ctx);
      
      if (!retriedResult.isError) {
        retriedResult.content = `[Self-Healing: Success! Patched ${loc.file}:${loc.line} to resolve error. Retry Output:]\n${retriedResult.content}`;
      } else {
        retriedResult.content = `[Self-Healing Attempted: Patched ${loc.file}:${loc.line} but command still failed. Retry Output:]\n${retriedResult.content}`;
      }
      return retriedResult;
    } catch (e) {
      console.error("Self-healing execution error:", e);
      return null;
    }
  }

  private async attemptDependencySelfHealing(
    toolUse: ToolUseBlock,
    result: ToolResult,
    ctx: ToolUseContext
  ): Promise<ToolResult | null> {
    const errorOutput = typeof result.content === "string" ? result.content : "";
    const dep = parseMissingDependency(errorOutput);
    if (!dep) return null;

    console.log(`[Self-Healing] Detected missing dependency: type=${dep.type}, name=${dep.name}`);
    
    let installCommand = "";
    if (dep.type === "python") {
      let pkgName = dep.name;
      const redirects: Record<string, string> = {
        'cv2': 'opencv-python',
        'bs4': 'beautifulsoup4',
        'yaml': 'pyyaml',
        'PIL': 'pillow',
        'OpenSSL': 'pyopenssl'
      };
      if (redirects[pkgName]) {
        pkgName = redirects[pkgName];
      }
      installCommand = `pip install ${pkgName}`;
    } else if (dep.type === "node") {
      let pkgName = dep.name;
      if (pkgName.includes('/')) {
        const parts = pkgName.split('/');
        pkgName = pkgName.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
      }
      installCommand = `npm install ${pkgName}`;
    } else if (dep.type === "go") {
      installCommand = `go get ${dep.name}`;
    }

    if (!installCommand) return null;

    const installToolUse: ToolUseBlock = {
      type: "tool_use",
      id: `install_${Date.now()}` as ToolUseId,
      name: "Bash",
      input: {
        command: installCommand,
        description: `Install missing dependency: ${dep.name}`
      }
    };

    console.log(`[Self-Healing] Executing installation: ${installCommand}`);
    const installResult = await this.executeToolWithPermissions(installToolUse, ctx);

    if (installResult.isError) {
      console.error(`[Self-Healing] Failed to install dependency: ${installResult.content}`);
      return null;
    }

    console.log(`[Self-Healing] Successfully installed dependency. Retrying original command...`);
    const retriedResult = await this.executeToolWithPermissions(toolUse, ctx);
    
    if (!retriedResult.isError) {
      retriedResult.content = `[Self-Healing: Success! Automatically installed missing dependency using \`${installCommand}\`. Retry Output:]\n${retriedResult.content}`;
    } else {
      retriedResult.content = `[Self-Healing Attempted: Installed dependency \`${dep.name}\` but command still failed. Retry Output:]\n${retriedResult.content}`;
    }
    
    return retriedResult;
  }
}

function parseErrorLocation(content: string): { file: string; line: number } | null {
  const pyMatch = content.match(/File "([^"]+)", line (\d+)/);
  if (pyMatch && pyMatch[1] && pyMatch[2]) {
    return { file: pyMatch[1], line: parseInt(pyMatch[2], 10) };
  }

  const nodeMatch = content.match(/at\s+.*\s+\(([^)]+):(\d+):(\d+)\)/);
  if (nodeMatch && nodeMatch[1] && nodeMatch[2]) {
    return { file: nodeMatch[1], line: parseInt(nodeMatch[2], 10) };
  }

  const genericMatch = content.match(/at\s+([^)\s]+):(\d+):(\d+)/);
  if (genericMatch && genericMatch[1] && genericMatch[2]) {
    return { file: genericMatch[1], line: parseInt(genericMatch[2], 10) };
  }

  const compileMatch = content.match(/([^:\s\n]+):(\d+):(\d+):/);
  if (compileMatch && compileMatch[1] && compileMatch[2]) {
    return { file: compileMatch[1], line: parseInt(compileMatch[2], 10) };
  }

  const compileMatchSimple = content.match(/([^:\s\n]+):(\d+):/);
  if (compileMatchSimple && compileMatchSimple[1] && compileMatchSimple[2]) {
    return { file: compileMatchSimple[1], line: parseInt(compileMatchSimple[2], 10) };
  }

  return null;
}

function parseMissingDependency(output: string): { type: 'python' | 'node' | 'go'; name: string } | null {
  // Python ModuleNotFoundError or ImportError
  const pyMatch = output.match(/ModuleNotFoundError:\s*No\s*module\s*named\s*['"]?([a-zA-Z0-9_\-]+)['"]?/i) 
               || output.match(/ImportError:\s*No\s*module\s*named\s*['"]?([a-zA-Z0-9_\-]+)['"]?/i);
  if (pyMatch && pyMatch[1]) {
    return { type: 'python', name: pyMatch[1] };
  }

  // Node.js Cannot find module
  const nodeMatch = output.match(/Error:\s*Cannot\s*find\s*module\s*['"]?([a-zA-Z0-9_\-\/]+)['"]/i);
  if (nodeMatch && nodeMatch[1]) {
    if (!nodeMatch[1].startsWith('.') && !nodeMatch[1].startsWith('/')) {
      return { type: 'node', name: nodeMatch[1] };
    }
  }

  // Golang no required module
  const goMatch = output.match(/no required module provides package ([a-zA-Z0-9_\-\.\/]+)/i);
  if (goMatch && goMatch[1]) {
    return { type: 'go', name: goMatch[1] };
  }

  return null;
}

async function getLlmCompletion(
  model: string,
  systemPrompt: string,
  userPrompt: string,
  signal: AbortSignal
): Promise<string> {
  const events = callModel({
    model,
    system: systemPrompt,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: userPrompt }]
      }
    ],
    tools: [],
    thinkingConfig: { type: "disabled" },
    signal
  });
  
  let accumulatedText = "";
  for await (const event of events) {
    if (event.type === "content_block_delta") {
      accumulatedText += event.delta;
    }
  }
  return accumulatedText;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Rough token estimate used for compaction triggering.
 * Real implementation would use tiktoken or the model's tokeniser.
 * Blueprint comment notes they use a simple character-count heuristic here too.
 */
function estimateBlockChars(block: ContentBlock): number {
  let chars = 0;
  if (!block) return 0;
  if (block.type === "text") {
    chars += block.text?.length || 0;
  } else if (block.type === "thinking") {
    chars += (block as any).thinking?.length || 0;
  } else if (block.type === "tool_use") {
    chars += block.name?.length || 0;
    if (block.input) {
      try {
        chars += JSON.stringify(block.input).length;
      } catch {
        chars += 50;
      }
    }
  } else if (block.type === "tool_result") {
    if (typeof block.content === "string") {
      chars += block.content.length;
    } else if (Array.isArray(block.content)) {
      for (const sub of block.content) {
        chars += estimateBlockChars(sub);
      }
    }
  } else if (block.type === "image") {
    chars += 2000;
  }
  return chars;
}

function estimateTokens(messages: Message[]): number {
  let chars = 0;
  for (const msg of messages) {
    for (const block of msg.content) {
      chars += estimateBlockChars(block);
    }
  }
  return Math.ceil(chars / 4); // ~4 chars per token
}

/**
 * Placeholder: in the real implementation the stream events accumulate content
 * into an array as they arrive. This function would return that accumulation.
 */
function extractContentFromStream(): ContentBlock[] {
  // Handled by the streaming loop in callModel — stub here
  return [];
}
