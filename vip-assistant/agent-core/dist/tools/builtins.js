/**
 * AGENT CORE — tools/builtins.ts
 *
 * The core built-in tools, derived from the blueprint's tools/ directory:
 *   BashTool, FileReadTool, FileWriteTool, FileEditTool,
 *   GlobTool, GrepTool, WebSearchTool, WebFetchTool
 *
 * Each tool follows the ToolDefinition<TInput> interface:
 *   - inputSchema  → JSON Schema for input validation
 *   - validate()   → pre-execution checks (path safety, etc.)
 *   - checkPermission() → user-approval gate
 *   - execute()    → async generator yielding progress, returning ToolResult
 *
 * Design notes from blueprint analysis:
 *  - BashTool runs commands in a persistent shell session (one per agent session)
 *    with configurable timeouts; default 120s, max 600s.
 *  - FileReadTool supports line-range reads to avoid flooding context.
 *  - FileEditTool uses a "search → replace" mechanism matching str_replace_editor;
 *    not a full file rewrite.
 *  - GlobTool and GrepTool are lightweight wrappers that avoid spawning grep/find
 *    when pure-JS alternatives are fast enough for small repos.
 */
import { exec, spawn } from "child_process";
import { promisify } from "util";
import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join, resolve, extname } from "path";
import { glob } from "glob"; // npm: glob
// Global hook for user permission dialogs over WebSocket
let promptUserApproval = async () => ({ granted: true });
export function setPermissionPromptHandler(handler) {
    promptUserApproval = handler;
}
const execAsync = promisify(exec);
export const BashTool = {
    name: "Bash",
    description: "Execute a shell command and return stdout/stderr. " +
        "Use for running tests, building projects, installing packages, git operations, etc. " +
        "Prefer single-purpose commands. Avoid interactive commands (vim, less, ssh).",
    inputSchema: {
        type: "object",
        properties: {
            command: { type: "string", description: "The shell command to execute" },
            timeout: { type: "number", description: "Timeout in seconds (default 120, max 600)" },
            description: { type: "string", description: "One-line description of what this command does" },
        },
        required: ["command"],
    },
    validate(input) {
        if (!input.command?.trim()) {
            return { valid: false, message: "Command cannot be empty", code: 400 };
        }
        const timeout = input.timeout ?? 120;
        if (timeout > 600) {
            return { valid: false, message: "Timeout cannot exceed 600 seconds", code: 400 };
        }
        // Block obviously dangerous patterns
        const BLOCKED = [
            /\brm\s+-rf\s+\/(?:\s|$)/, // rm -rf /
            /\bmkfs\b/, // filesystem format
            /\bdd\s+if=.*of=\/dev/, // low-level disk write
        ];
        for (const pattern of BLOCKED) {
            if (pattern.test(input.command)) {
                return { valid: false, message: `Command matches blocked pattern: ${pattern}`, code: 403 };
            }
        }
        return { valid: true };
    },
    async checkPermission(input, ctx) {
        if (ctx.permissionMode === "bypassPermissions")
            return { granted: true };
        const READ_ONLY = /^(cat|head|tail|ls|find|grep|echo|pwd|which|env|git (log|diff|status|show)|wc|sort|uniq)\b/;
        if (READ_ONLY.test(input.command.trimStart()))
            return { granted: true };
        const res = await promptUserApproval("Bash", input);
        return res.granted ? { granted: true } : { granted: false, reason: res.reason || "Permission denied" };
    },
    async *execute(input, ctx) {
        const timeout = (input.timeout ?? 120) * 1000;
        yield { type: "progress", data: null, label: input.description ?? input.command };
        const queue = [];
        let resolveNext = null;
        let finished = false;
        const child = spawn(input.command, [], {
            shell: true,
            cwd: ctx.cwd,
            env: { ...process.env },
            signal: ctx.abortSignal
        });
        let stdoutAccum = "";
        let stderrAccum = "";
        child.stdout.on("data", (data) => {
            const text = data.toString();
            stdoutAccum += text;
            queue.push({ type: "stdout", text });
            if (resolveNext) {
                resolveNext();
                resolveNext = null;
            }
        });
        child.stderr.on("data", (data) => {
            const text = data.toString();
            stderrAccum += text;
            queue.push({ type: "stderr", text });
            if (resolveNext) {
                resolveNext();
                resolveNext = null;
            }
        });
        let exitCode = 0;
        let error = null;
        child.on("close", (code) => {
            exitCode = code ?? 0;
            finished = true;
            if (resolveNext) {
                resolveNext();
                resolveNext = null;
            }
        });
        child.on("error", (err) => {
            error = err;
            finished = true;
            if (resolveNext) {
                resolveNext();
                resolveNext = null;
            }
        });
        // Timeout guard
        const timer = setTimeout(() => {
            child.kill();
            error = new Error("Command timed out");
            finished = true;
            if (resolveNext) {
                resolveNext();
                resolveNext = null;
            }
        }, timeout);
        while (queue.length > 0 || !finished) {
            if (queue.length === 0) {
                await new Promise((resolve) => {
                    resolveNext = resolve;
                });
            }
            while (queue.length > 0) {
                const item = queue.shift();
                yield { type: "progress", data: item, label: item.text };
            }
        }
        clearTimeout(timer);
        if (error) {
            return { content: error.message || "Command failed", isError: true };
        }
        const output = [
            stdoutAccum.trim() ? stdoutAccum.trim() : null,
            stderrAccum.trim() ? `<stderr>\n${stderrAccum.trim()}\n</stderr>` : null,
        ]
            .filter(Boolean)
            .join("\n");
        return { content: output || "(no output)", isError: exitCode !== 0 };
    },
};
export const FileReadTool = {
    name: "Read",
    description: "Read a file's contents. Optionally specify start_line/end_line to read a range. " +
        "Always prefer reading specific line ranges for large files.",
    inputSchema: {
        type: "object",
        properties: {
            file_path: { type: "string" },
            start_line: { type: "number" },
            end_line: { type: "number" },
        },
        required: ["file_path"],
    },
    validate(input, ctx) {
        const abs = safeResolvePath(input.file_path, ctx.cwd);
        if (!abs)
            return { valid: false, message: "Path traversal detected", code: 403 };
        if (!existsSync(abs))
            return { valid: false, message: `File not found: ${input.file_path}`, code: 404 };
        return { valid: true };
    },
    async *execute(input, ctx) {
        const abs = resolve(ctx.cwd, input.file_path);
        yield { type: "progress", data: null, label: `Reading ${input.file_path}` };
        const raw = await readFile(abs, "utf8");
        const lines = raw.split("\n");
        const start = (input.start_line ?? 1) - 1;
        const end = input.end_line ? input.end_line : lines.length;
        const slice = lines.slice(start, end);
        // Add line numbers (matches blueprint's cat -n style output)
        const numbered = slice
            .map((l, i) => `${String(start + i + 1).padStart(6)}\t${l}`)
            .join("\n");
        return {
            content: numbered,
            metadata: { totalLines: lines.length, readLines: slice.length },
        };
    },
};
export const FileWriteTool = {
    name: "Write",
    description: "Write content to a file, creating it if it does not exist. " +
        "This OVERWRITES the entire file. For small edits, prefer the Edit tool.",
    inputSchema: {
        type: "object",
        properties: {
            file_path: { type: "string" },
            content: { type: "string" },
        },
        required: ["file_path", "content"],
    },
    async checkPermission(input, ctx) {
        if (ctx.permissionMode === "bypassPermissions" || ctx.permissionMode === "acceptEdits") {
            return { granted: true };
        }
        const res = await promptUserApproval("Write", input);
        return res.granted ? { granted: true } : { granted: false, reason: res.reason || "Permission denied" };
    },
    async *execute(input, ctx) {
        const abs = resolve(ctx.cwd, input.file_path);
        yield { type: "progress", data: null, label: `Writing ${input.file_path}` };
        // Ensure parent directories exist
        const dir = abs.substring(0, abs.lastIndexOf("/"));
        await mkdir(dir, { recursive: true });
        // Cache the old content for undo / file history
        let oldContent = null;
        if (existsSync(abs)) {
            oldContent = await readFile(abs, "utf8").catch(() => null);
        }
        await writeFile(abs, input.content, "utf8");
        const added = input.content.split("\n").length;
        const removed = oldContent ? oldContent.split("\n").length : 0;
        return {
            content: `Written ${input.file_path} (${added} lines)`,
            metadata: { linesAdded: added, linesRemoved: removed },
        };
    },
};
export const FileEditTool = {
    name: "Edit",
    description: "Replace an exact string in a file. old_string must appear EXACTLY ONCE. " +
        "Read the file first to get the exact text. Prefer surgical edits over full rewrites.",
    inputSchema: {
        type: "object",
        properties: {
            file_path: { type: "string" },
            old_string: { type: "string", description: "Exact text to find (must be unique in file)" },
            new_string: { type: "string", description: "Text to replace it with" },
        },
        required: ["file_path", "old_string", "new_string"],
    },
    validate(input, ctx) {
        const abs = resolve(ctx.cwd, input.file_path);
        if (!existsSync(abs)) {
            return { valid: false, message: `File not found: ${input.file_path}`, code: 404 };
        }
        return { valid: true };
    },
    async checkPermission(input, ctx) {
        if (ctx.permissionMode === "bypassPermissions" || ctx.permissionMode === "acceptEdits") {
            return { granted: true };
        }
        const res = await promptUserApproval("Edit", input);
        return res.granted ? { granted: true } : { granted: false, reason: res.reason || "Permission denied" };
    },
    async *execute(input, ctx) {
        const abs = resolve(ctx.cwd, input.file_path);
        yield { type: "progress", data: null, label: `Editing ${input.file_path}` };
        const content = await readFile(abs, "utf8");
        const occurrences = countOccurrences(content, input.old_string);
        if (occurrences === 0) {
            return {
                content: `old_string not found in ${input.file_path}. Read the file first to get the exact text.`,
                isError: true,
            };
        }
        if (occurrences > 1) {
            return {
                content: `old_string appears ${occurrences} times in ${input.file_path}. Make it more specific.`,
                isError: true,
            };
        }
        const updated = content.replace(input.old_string, input.new_string);
        await writeFile(abs, updated, "utf8");
        return { content: `Edited ${input.file_path}` };
    },
};
export const GlobTool = {
    name: "Glob",
    description: "Find files matching a glob pattern (e.g. **/*.ts, src/**/*.test.js). " +
        "Returns sorted list of matching file paths relative to the search root.",
    inputSchema: {
        type: "object",
        properties: {
            pattern: { type: "string" },
            path: { type: "string", description: "Root directory (default: cwd)" },
            exclude: { type: "array", items: { type: "string" } },
        },
        required: ["pattern"],
    },
    async *execute(input, ctx) {
        const root = input.path ? resolve(ctx.cwd, input.path) : ctx.cwd;
        yield { type: "progress", data: null, label: `Searching ${input.pattern}` };
        const ignore = [
            "**/node_modules/**",
            "**/.git/**",
            ...(input.exclude ?? []),
        ];
        const matches = await glob(input.pattern, {
            cwd: root,
            ignore,
            nodir: true,
        });
        matches.sort();
        return {
            content: matches.length > 0
                ? matches.join("\n")
                : "(no files matched)",
            metadata: { count: matches.length },
        };
    },
};
export const GrepTool = {
    name: "Grep",
    description: "Search for a pattern in files. Returns matching lines with file:line context. " +
        "Use glob to restrict the file set (e.g. **/*.ts).",
    inputSchema: {
        type: "object",
        properties: {
            pattern: { type: "string", description: "Regex pattern to search for" },
            path: { type: "string", description: "Directory to search (default: cwd)" },
            glob: { type: "string", description: "File pattern filter (default: **/*)" },
            case_insensitive: { type: "boolean" },
        },
        required: ["pattern"],
    },
    async *execute(input, ctx) {
        const root = input.path ? resolve(ctx.cwd, input.path) : ctx.cwd;
        const flags = input.case_insensitive ? "gi" : "g";
        const re = new RegExp(input.pattern, flags);
        yield { type: "progress", data: null, label: `Searching for "${input.pattern}"` };
        const files = await glob(input.glob ?? "**/*", {
            cwd: root,
            ignore: ["**/node_modules/**", "**/.git/**"],
            nodir: true,
        });
        const results = [];
        const TEXT_EXTS = new Set([
            ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs",
            ".java", ".c", ".cpp", ".h", ".md", ".txt", ".json",
            ".yaml", ".yml", ".toml", ".sh", ".css", ".html",
        ]);
        for (const file of files) {
            const ext = extname(file).toLowerCase();
            if (!TEXT_EXTS.has(ext) && ext !== "")
                continue;
            const abs = join(root, file);
            let content;
            try {
                content = await readFile(abs, "utf8");
            }
            catch {
                continue;
            }
            const lines = content.split("\n");
            for (let i = 0; i < lines.length; i++) {
                if (re.test(lines[i])) {
                    results.push(`${file}:${i + 1}: ${lines[i].trim()}`);
                }
                re.lastIndex = 0; // reset stateful regex
            }
            if (results.length > 500) {
                results.push("... (truncated at 500 matches)");
                break;
            }
        }
        return {
            content: results.length > 0 ? results.join("\n") : "(no matches)",
            metadata: { matchCount: results.length },
        };
    },
};
export const WebSearchTool = {
    name: "WebSearch",
    description: "Search the web for current information. Use for documentation, " +
        "error messages, recent releases, or anything not in training data.",
    inputSchema: {
        type: "object",
        properties: {
            query: { type: "string" },
        },
        required: ["query"],
    },
    async *execute(input, _ctx) {
        yield { type: "progress", data: null, label: `Searching: ${input.query}` };
        // In production this calls a real search API (Brave, Google, etc.)
        // Blueprint wires this through the model's native web_search_20250305 tool type
        return {
            content: `[WebSearch placeholder] Query: "${input.query}"\n` +
                "In production, this calls a real search API and returns results.",
            isError: false,
        };
    },
};
// ─── Utilities ────────────────────────────────────────────────────────────────
function safeResolvePath(inputPath, cwd) {
    const abs = resolve(cwd, inputPath);
    // Ensure the resolved path is within cwd (prevent traversal)
    if (!abs.startsWith(resolve(cwd)))
        return null;
    return abs;
}
function countOccurrences(haystack, needle) {
    let count = 0;
    let pos = 0;
    while ((pos = haystack.indexOf(needle, pos)) !== -1) {
        count++;
        pos += needle.length;
    }
    return count;
}
// ─── Registry builder ─────────────────────────────────────────────────────────
export function createDefaultToolRegistry() {
    const registry = new Map();
    for (const tool of [BashTool, FileReadTool, FileWriteTool, FileEditTool, GlobTool, GrepTool, WebSearchTool]) {
        registry.set(tool.name, tool);
    }
    return registry;
}
