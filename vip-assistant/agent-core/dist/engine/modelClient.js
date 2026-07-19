/**
 * AGENT CORE — engine/modelClient.ts
 *
 * Thin streaming wrapper around the Anthropic Messages API.
 * Inferred from: services/api/claude.ts, query.ts, utils/thinking.ts
 *
 * Design notes from blueprint analysis:
 *  - The blueprint uses prompt-caching betas aggressively (cache_control blocks)
 *  - Thinking tokens are gated by a ThinkingConfig + model capability check
 *  - Retry logic: rate-limit errors get exponential backoff; other 5xx get 1 retry
 *  - The client streams via EventSource/SSE, not WebSocket, for the main loop
 *  - Usage is returned on the final message_stop event
 */
/** Map model name → cost per 1k tokens [input, output] in USD */
export const COST_PER_1K = {
    "claude-opus-4-5": [0.015, 0.075],
    "claude-sonnet-4-5": [0.003, 0.015],
    "claude-haiku-4-5": [0.00025, 0.00125],
    // Fallback for unknown models
    default: [0.003, 0.015],
};
const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
/** Default max output tokens; budget-constrained runs use lower values. */
const DEFAULT_MAX_TOKENS = 8192;
/** Maximum retry attempts for retryable errors. */
const MAX_RETRIES = 3;
/** Base delay for exponential back-off (ms). */
const RETRY_BASE_MS = 1000;
// ─────────────────────────────────────────────────────────────────────────────
export async function* callModel(params) {
    let attempt = 0;
    while (attempt <= MAX_RETRIES) {
        try {
            yield* callModelOnce(params);
            return;
        }
        catch (err) {
            const ae = classifyApiError(err);
            if (!ae.retryable || attempt >= MAX_RETRIES) {
                yield { type: "error", error: ae };
                return;
            }
            const delay = RETRY_BASE_MS * 2 ** attempt;
            await sleep(delay);
            attempt++;
        }
    }
}
// ─── Single-attempt streaming call ───────────────────────────────────────────
async function* callModelOnce(params) {
    if (params.model.startsWith("nvidia/")) {
        yield* callModelNvidia(params);
        return;
    }
    if (params.model.startsWith("ollama/")) {
        yield* callModelOllama(params);
        return;
    }
    if (params.model.startsWith("gemini")) {
        yield* callModelGemini(params);
        return;
    }
    const { model, system, messages, tools, thinkingConfig, signal, maxTokens = DEFAULT_MAX_TOKENS, } = params;
    const body = buildRequestBody({
        model,
        system,
        messages,
        tools,
        thinkingConfig,
        maxTokens,
    });
    const resp = await fetch(ANTHROPIC_API, {
        method: "POST",
        headers: buildHeaders(),
        body: JSON.stringify(body),
        signal,
    });
    if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new ApiError(resp.status, text);
    }
    if (!resp.body)
        throw new ApiError(0, "Empty response body");
    yield* parseSSEStream(resp.body);
}
async function* callModelGemini(params) {
    const { model, system, messages, tools, signal, maxTokens = DEFAULT_MAX_TOKENS, } = params;
    const url = "https://generativelanguage.googleapis.com/v1beta/openai/v1/chat/completions";
    const apiKey = process.env["GEMINI_API_KEY"] || "";
    const mappedMessages = mapMessagesForOllama(system, messages);
    const mappedTools = tools && tools.length > 0 ? tools.map(t => ({
        type: "function",
        function: {
            name: t.name,
            description: t.description,
            parameters: t.input_schema || { type: "object", properties: {} }
        }
    })) : undefined;
    let actualModel = model;
    if (actualModel === "gemini-1.5-flash") {
        actualModel = "gemini-2.5-flash";
    }
    else if (actualModel === "gemini-1.5-pro") {
        actualModel = "gemini-2.5-pro";
    }
    const body = {
        model: actualModel,
        messages: mappedMessages,
        stream: true,
    };
    if (mappedTools) {
        body.tools = mappedTools;
    }
    if (maxTokens) {
        body.max_tokens = maxTokens;
    }
    console.log(`[callModelGemini] Starting request for model: ${actualModel}, URL: ${url}`);
    console.log(`[callModelGemini] API Key length: ${apiKey.length}`);
    const resp = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify(body),
        signal,
    });
    console.log(`[callModelGemini] Response status: ${resp.status}`);
    if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        console.error(`[callModelGemini] Error status=${resp.status}: ${text}`);
        throw new ApiError(resp.status, `Gemini API Error: ${text}`);
    }
    if (!resp.body)
        throw new ApiError(0, "Empty response body from Gemini");
    console.log(`[callModelGemini] Stream response OK, parsing SSE stream...`);
    yield* parseOllamaSSEStream(resp.body, messages, tools);
}
async function* callModelNvidia(params) {
    const { model, system, messages, tools, signal, maxTokens = DEFAULT_MAX_TOKENS, } = params;
    const url = "https://integrate.api.nvidia.com/v1/chat/completions";
    const apiKey = process.env["NVIDIA_API_KEY"] || "";
    const mappedMessages = mapMessagesForOllama(system, messages);
    const mappedTools = tools && tools.length > 0 ? tools.map(t => ({
        type: "function",
        function: {
            name: t.name,
            description: t.description,
            parameters: t.input_schema || { type: "object", properties: {} }
        }
    })) : undefined;
    const actualModel = model.replace(/^nvidia\//, "");
    const body = {
        model: actualModel,
        messages: mappedMessages,
        stream: true,
    };
    if (mappedTools) {
        body.tools = mappedTools;
    }
    if (maxTokens) {
        body.max_tokens = maxTokens;
    }
    let resp = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify(body),
        signal,
    });
    if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        let retryNeeded = false;
        const fallbackBody = { ...body };
        if (text.includes("max_tokens") && text.includes("less_than_equal")) {
            const match = text.match(/le=(\d+)/);
            if (match && match[1]) {
                fallbackBody.max_tokens = parseInt(match[1], 10);
            }
            else {
                fallbackBody.max_tokens = 4096;
            }
            retryNeeded = true;
        }
        if (text.includes("tools") && text.includes("extra_forbidden")) {
            delete fallbackBody.tools;
            if (fallbackBody.messages) {
                const warning = "\n\n[SYSTEM NOTICE: This model does not support tool calling. You currently do NOT have access to tools. Do NOT hallucinate search results, files, folders, or terminal outputs. If the user asks you to perform tool-based actions, politely explain that your model is running in chat-only mode without tool access.]";
                const systemMsg = fallbackBody.messages.find((m) => m.role === "system");
                if (systemMsg) {
                    systemMsg.content += warning;
                }
                else {
                    fallbackBody.messages.unshift({
                        role: "system",
                        content: "You are an AI assistant." + warning
                    });
                }
            }
            retryNeeded = true;
        }
        if (retryNeeded) {
            resp = await fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${apiKey}`
                },
                body: JSON.stringify(fallbackBody),
                signal,
            });
            if (!resp.ok) {
                const fallbackText = await resp.text().catch(() => "");
                throw new ApiError(resp.status, `NVIDIA API Error: ${fallbackText}`);
            }
        }
        else {
            throw new ApiError(resp.status, `NVIDIA API Error: ${text}`);
        }
    }
    if (!resp.body)
        throw new ApiError(0, "Empty response body from NVIDIA");
    yield* parseOllamaSSEStream(resp.body, messages, tools);
}
// ─── Ollama execution path ───────────────────────────────────────────────────
async function* callModelOllama(params) {
    const { model, system, messages, tools, signal, maxTokens = DEFAULT_MAX_TOKENS, } = params;
    const actualModel = model.replace(/^ollama\//, "");
    const ollamaHost = process.env["OLLAMA_HOST"] || "http://localhost:11434";
    const url = `${ollamaHost.replace(/\/$/, "")}/v1/chat/completions`;
    const mappedMessages = mapMessagesForOllama(system, messages);
    const mappedTools = tools && tools.length > 0 ? tools.map(t => ({
        type: "function",
        function: {
            name: t.name,
            description: t.description,
            parameters: t.input_schema || { type: "object", properties: {} }
        }
    })) : undefined;
    const body = {
        model: actualModel,
        messages: mappedMessages,
        stream: true,
        stream_options: { include_usage: true }
    };
    if (mappedTools) {
        body.tools = mappedTools;
    }
    if (maxTokens) {
        body.max_tokens = maxTokens;
    }
    const resp = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify(body),
        signal,
    });
    if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        if (text.includes("does not support tool") && body.tools) {
            const fallbackBody = { ...body };
            delete fallbackBody.tools;
            // Inject tool disable warning to prevent model hallucinating tool operations
            if (fallbackBody.messages) {
                const warning = "\n\n[SYSTEM NOTICE: This model does not support tool calling. You currently do NOT have access to tools (like Glob, Read, Write, Edit, Bash). Do NOT hallucinate search results, files, folders, or terminal outputs. If the user asks you to perform tool-based actions, politely explain that your model is running in chat-only mode without tool access, and suggest they switch to qwen2.5-coder:7b in the settings.]";
                const systemMsg = fallbackBody.messages.find(m => m.role === "system");
                if (systemMsg) {
                    systemMsg.content += warning;
                }
                else {
                    fallbackBody.messages.unshift({
                        role: "system",
                        content: "You are an AI assistant." + warning
                    });
                }
            }
            const fallbackResp = await fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(fallbackBody),
                signal,
            });
            if (!fallbackResp.ok) {
                const fallbackText = await fallbackResp.text().catch(() => "");
                throw new ApiError(fallbackResp.status, `Ollama API Error: ${fallbackText}`);
            }
            if (!fallbackResp.body)
                throw new ApiError(0, "Empty response body from Ollama");
            yield* parseOllamaSSEStream(fallbackResp.body, messages, tools);
            return;
        }
        throw new ApiError(resp.status, `Ollama API Error: ${text}`);
    }
    if (!resp.body)
        throw new ApiError(0, "Empty response body from Ollama");
    yield* parseOllamaSSEStream(resp.body, messages, tools);
}
function tryJsonRepair(rawText) {
    let text = rawText.trim();
    // Convert leading/trailing parenthesis to braces if present
    if (text.startsWith("(") && text.endsWith(")")) {
        text = "{" + text.slice(1, -1) + "}";
    }
    else if (text.startsWith("(") && !text.endsWith(")")) {
        text = "{" + text.slice(1);
    }
    // Convert single quotes around strings/keys to double quotes
    text = text.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, '"$1"');
    // 1. Replace smart/curly quotes with standard double quotes
    text = text.replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"');
    text = text.replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'");
    // 2. Wrap unquoted keys in double quotes (e.g. { name: "Bash" } -> { "name": "Bash" })
    text = text.replace(/([{,]\s*)([a-zA-Z0-9_]+)\s*:/g, '$1"$2":');
    // 3. Balance trailing braces/brackets
    const openBraces = (text.match(/\{/g) || []).length;
    const closeBraces = (text.match(/\}/g) || []).length;
    if (openBraces > closeBraces) {
        text += '}'.repeat(openBraces - closeBraces);
    }
    const openBrackets = (text.match(/\[/g) || []).length;
    const closeBrackets = (text.match(/\]/g) || []).length;
    if (openBrackets > closeBrackets) {
        text += ']'.repeat(openBrackets - closeBrackets);
    }
    try {
        return JSON.parse(text);
    }
    catch {
        return null;
    }
}
function extractJsonToolCall(text, tools) {
    const trimmed = text.trim();
    let parsed = null;
    const isBraced = (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
        (trimmed.startsWith("(") && trimmed.endsWith(")"));
    if (isBraced) {
        try {
            parsed = JSON.parse(trimmed);
        }
        catch {
            parsed = tryJsonRepair(trimmed);
        }
    }
    if (!parsed) {
        const match = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (match && match[1]) {
            try {
                parsed = JSON.parse(match[1].trim());
            }
            catch {
                parsed = tryJsonRepair(match[1].trim());
            }
        }
    }
    if (!parsed) {
        const startIdx = Math.min(trimmed.indexOf("{") === -1 ? Infinity : trimmed.indexOf("{"), trimmed.indexOf("(") === -1 ? Infinity : trimmed.indexOf("("));
        const endIdx = Math.max(trimmed.lastIndexOf("}"), trimmed.lastIndexOf(")"));
        if (startIdx !== Infinity && endIdx !== -1 && endIdx > startIdx) {
            const sub = trimmed.slice(startIdx, endIdx + 1);
            try {
                parsed = JSON.parse(sub);
            }
            catch {
                parsed = tryJsonRepair(sub);
            }
        }
    }
    if (parsed && typeof parsed === "object") {
        const nameKey = parsed.name || parsed.type;
        if (typeof nameKey === "string") {
            const toolNames = Array.from(tools?.map(t => t.name) || []);
            const matchedName = toolNames.find(t => t.toLowerCase() === nameKey.toLowerCase());
            if (matchedName) {
                let args = parsed.arguments;
                if (!args || typeof args !== "object") {
                    args = { ...parsed };
                    delete args.name;
                    delete args.type;
                    delete args.arguments;
                }
                // Arguments Self-Healing: Unpack schema objects if models hallucinated nested structures
                if (args && typeof args === "object") {
                    for (const key of Object.keys(args)) {
                        const val = args[key];
                        if (val && typeof val === "object") {
                            if (val[key] !== undefined) {
                                args[key] = val[key];
                            }
                            else if (val.value !== undefined) {
                                args[key] = val.value;
                            }
                            else if (val.content !== undefined && key === "CodeContent") {
                                args[key] = val.content;
                            }
                            else if (val.command !== undefined && (key === "CommandLine" || key === "command")) {
                                args[key] = val.command;
                            }
                        }
                    }
                }
                return { name: matchedName, arguments: args };
            }
        }
    }
    return null;
}
async function* parseOllamaSSEStream(body, messages, tools) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let accumulatedText = "";
    let isBufferingJson = false;
    let jsonBuffer = "";
    let isToolCall = false;
    let hasMarkdownWrapper = false;
    let swallowRemainingTicks = false;
    const toolCallsAccumulator = [];
    let finalUsage = { input_tokens: 0, output_tokens: 0 };
    let finalStopReason = "end_turn";
    yield {
        type: "message_start",
        usage: { input_tokens: 0, output_tokens: 0 }
    };
    try {
        console.log(`[parseOllamaSSEStream] Starting stream reader loop`);
        while (true) {
            const { value, done } = await reader.read();
            console.log(`[parseOllamaSSEStream] Chunk read: done=${done}, hasValue=${!!value}`);
            if (done)
                break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
                const cleaned = line.trim();
                if (!cleaned || !cleaned.startsWith("data:"))
                    continue;
                let data = cleaned.slice(5).trim();
                if (data.startsWith(":")) {
                    data = data.slice(1).trim();
                }
                if (data === "[DONE]")
                    break;
                let chunk;
                try {
                    chunk = JSON.parse(data);
                    console.log("[DEBUG CHUNK RAW]", data);
                }
                catch {
                    continue;
                }
                if (chunk.usage) {
                    finalUsage.input_tokens = chunk.usage.prompt_tokens ?? finalUsage.input_tokens;
                    finalUsage.output_tokens = chunk.usage.completion_tokens ?? finalUsage.output_tokens;
                }
                const choices = chunk.choices || [];
                for (const choice of choices) {
                    const delta = choice.delta || {};
                    if (delta.content) {
                        // Check if we are in swallow mode for remaining backticks/newlines/braces after complete JSON
                        if (swallowRemainingTicks) {
                            const cleanDelta = delta.content.replace(/[\s`\}\)]+/g, "");
                            if (cleanDelta === "") {
                                continue; // Swallow it!
                            }
                            else {
                                swallowRemainingTicks = false; // Stop swallowing!
                            }
                        }
                        accumulatedText += delta.content;
                        // Check if we should start buffering JSON (new line followed by '{' or '(', or start of stream)
                        if (!isBufferingJson) {
                            const match = delta.content.match(/^([^\{\(]*)([\{\(])/);
                            if (match) {
                                const precedingText = accumulatedText.slice(0, -delta.content.length) + match[1];
                                const isNewLineOrStart = precedingText.trim() === "" || precedingText.endsWith("\n");
                                if (isNewLineOrStart) {
                                    isBufferingJson = true;
                                    // Check if there is an open markdown code block right before the '{' or '('
                                    let markdownBracesLength = 0;
                                    const mdMatch = precedingText.match(/```(?:json)?\s*\n?\s*$/i);
                                    if (mdMatch) {
                                        markdownBracesLength = mdMatch[0].length;
                                        hasMarkdownWrapper = true;
                                    }
                                    else {
                                        hasMarkdownWrapper = false;
                                    }
                                    // Yield any text prior to the markdown block/brace
                                    if (match[1]) {
                                        const textToYield = match[1].slice(0, match[1].length - markdownBracesLength);
                                        if (textToYield) {
                                            yield {
                                                type: "content_block_delta",
                                                index: 0,
                                                delta: textToYield
                                            };
                                        }
                                    }
                                    // Put the '{' or '(' and everything after it in the jsonBuffer
                                    const braceChar = match[2];
                                    const braceIdx = delta.content.indexOf(braceChar);
                                    jsonBuffer = delta.content.slice(braceIdx);
                                    // Strip the JSON start and the markdown code block from accumulatedText so it doesn't leak
                                    accumulatedText = precedingText.slice(0, precedingText.length - markdownBracesLength);
                                    continue;
                                }
                            }
                        }
                        if (isBufferingJson) {
                            jsonBuffer += delta.content;
                            const hasToolKeys = jsonBuffer.includes('"name"') || jsonBuffer.includes('"arguments"') || jsonBuffer.includes('"type"') ||
                                jsonBuffer.includes("'name'") || jsonBuffer.includes("'arguments'") || jsonBuffer.includes("'type'");
                            const isTooLong = jsonBuffer.length > 500;
                            const trimmedBuf = jsonBuffer.trim();
                            let isCompleteToolCall = false;
                            const parsedTry = extractJsonToolCall(trimmedBuf, tools);
                            if (parsedTry) {
                                isCompleteToolCall = true;
                            }
                            if (isCompleteToolCall && parsedTry) {
                                toolCallsAccumulator.push({
                                    name: parsedTry.name,
                                    arguments: typeof parsedTry.arguments === "string" ? parsedTry.arguments : JSON.stringify(parsedTry.arguments)
                                });
                                isBufferingJson = false;
                                jsonBuffer = "";
                                let startIdx = accumulatedText.lastIndexOf("{");
                                if (startIdx === -1) {
                                    startIdx = accumulatedText.lastIndexOf("(");
                                }
                                if (startIdx !== -1) {
                                    accumulatedText = accumulatedText.slice(0, startIdx);
                                }
                                isToolCall = true;
                                if (hasMarkdownWrapper) {
                                    swallowRemainingTicks = true;
                                }
                            }
                            else if (isTooLong || (jsonBuffer.length > 100 && !hasToolKeys)) {
                                isBufferingJson = false;
                                yield {
                                    type: "content_block_delta",
                                    index: 0,
                                    delta: jsonBuffer
                                };
                                jsonBuffer = "";
                            }
                        }
                        else {
                            yield {
                                type: "content_block_delta",
                                index: 0,
                                delta: delta.content
                            };
                        }
                    }
                    if (delta.tool_calls) {
                        for (let i = 0; i < delta.tool_calls.length; i++) {
                            const tc = delta.tool_calls[i];
                            const idx = typeof tc.index === 'number' ? tc.index : i;
                            if (!toolCallsAccumulator[idx]) {
                                toolCallsAccumulator[idx] = { arguments: "" };
                            }
                            if (tc.id)
                                toolCallsAccumulator[idx].id = tc.id;
                            if (tc.function?.name)
                                toolCallsAccumulator[idx].name = tc.function.name;
                            if (tc.function?.arguments) {
                                toolCallsAccumulator[idx].arguments += tc.function.arguments;
                            }
                        }
                    }
                    if (choice.finish_reason) {
                        if (choice.finish_reason === "tool_calls") {
                            finalStopReason = "tool_use";
                        }
                        else if (choice.finish_reason === "length") {
                            finalStopReason = "max_tokens";
                        }
                        else {
                            finalStopReason = "end_turn";
                        }
                    }
                }
            }
        }
        const toolNames = new Set(tools?.map(t => t.name) || []);
        if (!isToolCall && toolCallsAccumulator.length === 0 && accumulatedText.trim()) {
            const extracted = extractJsonToolCall(accumulatedText, tools);
            if (extracted && toolNames.has(extracted.name)) {
                toolCallsAccumulator.push({
                    name: extracted.name,
                    arguments: typeof extracted.arguments === "string" ? extracted.arguments : JSON.stringify(extracted.arguments)
                });
                accumulatedText = ""; // Clear text output so it's not rendered as chatbot content
                isBufferingJson = false;
                jsonBuffer = "";
                isToolCall = true;
            }
        }
        if (isBufferingJson && jsonBuffer && !isToolCall) {
            yield {
                type: "content_block_delta",
                index: 0,
                delta: jsonBuffer
            };
        }
        if (finalUsage.input_tokens === 0) {
            finalUsage.input_tokens = Math.ceil(JSON.stringify(messages).length / 4);
            finalUsage.output_tokens = Math.ceil((accumulatedText.length + JSON.stringify(toolCallsAccumulator).length) / 4);
        }
        const contentBlocks = [];
        if (accumulatedText) {
            contentBlocks.push({
                type: "text",
                text: accumulatedText
            });
        }
        if (toolCallsAccumulator.length > 0) {
            finalStopReason = "tool_use";
            for (const tc of toolCallsAccumulator) {
                if (tc.name) {
                    let parsedArgs = {};
                    try {
                        parsedArgs = JSON.parse(tc.arguments || "{}");
                    }
                    catch {
                        parsedArgs = {};
                    }
                    contentBlocks.push({
                        type: "tool_use",
                        id: (tc.id || `call_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`),
                        name: tc.name,
                        input: parsedArgs
                    });
                }
            }
        }
        yield {
            type: "message_stop",
            usage: finalUsage,
            stopReason: finalStopReason,
            content: contentBlocks,
        };
    }
    finally {
        reader.releaseLock();
    }
}
function mapMessagesForOllama(system, messages) {
    const result = [];
    if (system) {
        result.push({ role: "system", content: system });
    }
    for (const msg of messages) {
        if (msg.role === "system") {
            result.push({ role: "system", content: getMessageText(msg) });
        }
        else if (msg.role === "user") {
            const toolResults = msg.content.filter(b => b.type === "tool_result");
            if (toolResults.length > 0) {
                for (const block of toolResults) {
                    if (block.type === "tool_result") {
                        let contentStr = "";
                        if (typeof block.content === "string") {
                            contentStr = block.content;
                        }
                        else if (Array.isArray(block.content)) {
                            contentStr = block.content.map(b => "text" in b ? b.text : "").join("\n");
                        }
                        // Map tool results as user role plain text blocks so Ollama sees it clearly
                        result.push({
                            role: "user",
                            content: `[TOOL RESULT for call_id: ${block.tool_use_id}]\n${contentStr || "Success"}`
                        });
                    }
                }
            }
            else {
                result.push({
                    role: "user",
                    content: getMessageText(msg)
                });
            }
        }
        else if (msg.role === "assistant") {
            const textBlocks = msg.content.filter(b => b.type === "text");
            const thinkingBlocks = msg.content.filter(b => b.type === "thinking");
            const toolUseBlocks = msg.content.filter(b => b.type === "tool_use");
            const contentParts = [
                ...thinkingBlocks.map(b => `[Thinking]\n${b.thinking}`),
                ...textBlocks.map(b => b.text)
            ];
            // Inject previous tool calls directly into plain text content so the model sees what it ran
            if (toolUseBlocks.length > 0) {
                for (const block of toolUseBlocks) {
                    if (block.type === "tool_use") {
                        contentParts.push(JSON.stringify({
                            name: block.name,
                            arguments: block.input
                        }, null, 2));
                    }
                }
            }
            const contentText = contentParts.join("\n").trim();
            result.push({
                role: "assistant",
                content: contentText || "Running tool..."
            });
        }
    }
    return result;
}
function getMessageText(msg) {
    if (typeof msg.content === "string")
        return msg.content;
    if (Array.isArray(msg.content)) {
        return msg.content.map(b => {
            if (b.type === "text")
                return b.text;
            if (b.type === "thinking")
                return b.thinking;
            return "";
        }).join("\n");
    }
    return "";
}
// ─── SSE stream parser ────────────────────────────────────────────────────────
async function* parseSSEStream(body) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    // Accumulation state for content blocks
    const contentBlocks = [];
    let currentBlockIndex = -1;
    let finalUsage = { input_tokens: 0, output_tokens: 0 };
    let finalStopReason = "end_turn";
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done)
                break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
                if (!line.startsWith("data: "))
                    continue;
                const data = line.slice(6).trim();
                if (data === "[DONE]")
                    break;
                let event;
                try {
                    event = JSON.parse(data);
                }
                catch {
                    continue;
                }
                // ── Dispatch stream events ───────────────────────────────────
                switch (event.type) {
                    case "message_start":
                        finalUsage = event.message.usage ?? finalUsage;
                        yield {
                            type: "message_start",
                            usage: finalUsage,
                        };
                        break;
                    case "content_block_start": {
                        currentBlockIndex = event.index;
                        const block = event.content_block;
                        contentBlocks[event.index] = block;
                        if (block.type === "tool_use") {
                            yield {
                                type: "tool_use_start",
                                toolUseId: block.id,
                                name: block.name,
                            };
                        }
                        else {
                            yield {
                                type: "content_block_start",
                                index: event.index,
                                block,
                            };
                        }
                        break;
                    }
                    case "content_block_delta": {
                        const delta = event.delta;
                        // Accumulate text into the block
                        const block = contentBlocks[event.index];
                        if (block?.type === "text" && delta.type === "text_delta") {
                            block.text = (block.text ?? "") + delta.text;
                            yield {
                                type: "content_block_delta",
                                index: event.index,
                                delta: delta.text,
                            };
                        }
                        else if (block?.type === "thinking" && delta.type === "thinking_delta") {
                            block.thinking =
                                (block.thinking ?? "") + delta.thinking;
                        }
                        else if (block?.type === "tool_use" && delta.type === "input_json_delta") {
                            // Accumulate partial JSON for tool input
                            block._inputJson =
                                (block._inputJson ?? "") + delta.partial_json;
                        }
                        break;
                    }
                    case "content_block_stop": {
                        const block = contentBlocks[event.index];
                        // Finalise tool_use input JSON
                        if (block?.type === "tool_use") {
                            try {
                                block.input = JSON.parse(block._inputJson ?? "{}");
                            }
                            catch {
                                block.input = {};
                            }
                        }
                        yield { type: "content_block_stop", index: event.index };
                        break;
                    }
                    case "message_delta":
                        if (event.usage) {
                            finalUsage.output_tokens = event.usage.output_tokens ?? finalUsage.output_tokens;
                        }
                        if (event.delta?.stop_reason) {
                            finalStopReason = event.delta.stop_reason;
                        }
                        break;
                    case "message_stop":
                        yield {
                            type: "message_stop",
                            usage: finalUsage,
                            stopReason: finalStopReason,
                            content: contentBlocks,
                        };
                        break;
                    case "error":
                        throw new ApiError(event.error?.status ?? 0, event.error?.message ?? "Unknown error");
                }
            }
        }
    }
    finally {
        reader.releaseLock();
    }
}
// ─── Request builder ──────────────────────────────────────────────────────────
function buildRequestBody(params) {
    const body = {
        model: params.model,
        max_tokens: params.maxTokens,
        system: [
            {
                type: "text",
                text: params.system,
                // Cache the system prompt — it changes infrequently and is large
                cache_control: { type: "ephemeral" },
            },
        ],
        messages: params.messages.map(serializeMessage),
        tools: params.tools,
        stream: true,
    };
    // Thinking / extended thinking support
    if (params.thinkingConfig.type === "enabled") {
        body.thinking = {
            type: "enabled",
            budget_tokens: params.thinkingConfig.budgetTokens,
        };
        body.betas = ["interleaved-thinking-2025-05-14"];
    }
    else if (params.thinkingConfig.type === "adaptive") {
        body.thinking = { type: "auto" };
        body.betas = ["interleaved-thinking-2025-05-14"];
    }
    return body;
}
function buildHeaders() {
    const apiKey = process.env["ANTHROPIC_API_KEY"] ?? "";
    return {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "prompt-caching-2024-07-31",
    };
}
function serializeMessage(msg) {
    return {
        role: msg.role === "system" ? "user" : msg.role,
        content: msg.content,
    };
}
// ─── Cost calculation ─────────────────────────────────────────────────────────
export function costFromUsage(usage, model) {
    if (model.startsWith("ollama/") || model.startsWith("gemini")) {
        return 0;
    }
    const [inputRate, outputRate] = COST_PER_1K[model] ?? COST_PER_1K["default"];
    const input = (usage.input_tokens / 1000) * inputRate;
    const output = (usage.output_tokens / 1000) * outputRate;
    // Cache reads are cheaper (blueprint charges ~10% of normal input price)
    const cacheRead = ((usage.cache_read_input_tokens ?? 0) / 1000) * inputRate * 0.1;
    return input + output + cacheRead;
}
// ─── Error handling ───────────────────────────────────────────────────────────
class ApiError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.status = status;
        this.name = "ApiError";
    }
}
function classifyApiError(err) {
    if (err instanceof ApiError) {
        const retryable = err.status === 429 || err.status >= 500;
        let code = "API_ERROR";
        if (err.status === 429)
            code = "API_RATE_LIMIT";
        return { code, message: err.message, retryable, details: { status: err.status } };
    }
    const msg = err instanceof Error ? err.message : String(err);
    const isAbort = msg.includes("abort") || msg.includes("AbortError");
    return {
        code: isAbort
            ? "ABORT"
            : "API_ERROR",
        message: msg,
        retryable: false,
    };
}
// ─── Utilities ────────────────────────────────────────────────────────────────
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
