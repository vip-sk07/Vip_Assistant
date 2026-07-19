import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import chokidar from 'chokidar';
import fs from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { GoogleGenerativeAI } from '@google/generative-ai';

const execAsync = promisify(exec);

// Import compiled agent-core and tools
import { createAgent } from './agent-core/dist/index.js';
import { 
  setPermissionPromptHandler,
  FileReadTool,
  FileWriteTool,
  FileEditTool,
  GlobTool,
  GrepTool,
  WebSearchTool
} from './agent-core/dist/tools/builtins.js';
import { setToolProgressHandler } from './agent-core/dist/engine/toolDispatch.js';

dotenv.config();

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;
let WORKSPACE_DIR = process.env.WORKSPACE_DIR || path.resolve('..');

// Global WS pointer & settings for the agent-core callback context
let currentWs = null;
const pendingApprovals = new Map();
const activeAborts = new Map();

// Hook up built-in tools permission checks to WebSocket prompts
setPermissionPromptHandler(async (toolName, input) => {
  if (!currentWs) {
    return { granted: true };
  }
  
  const toolCallId = `call_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
  
  currentWs.send(JSON.stringify({
    type: 'tool_request',
    toolCallId,
    name: toolName,
    args: input,
    autoApprove: false
  }));

  return new Promise((resolve) => {
    pendingApprovals.set(toolCallId, {
      resolve: (approved) => {
        if (approved) {
          resolve({ granted: true });
        } else {
          resolve({ granted: false, reason: "Tool execution was rejected by user." });
        }
      }
    });
  });
});

// Hook up built-in tools progress updates to WebSocket messages
setToolProgressHandler(({ toolName, event }) => {
  if (!currentWs) return;
  
  if (toolName === 'Bash' && event.type === 'progress' && event.data) {
    const data = event.data;
    if (data.type === 'stdout') {
      currentWs.send(JSON.stringify({ type: 'terminal_output', text: data.text }));
    } else if (data.type === 'stderr') {
      currentWs.send(JSON.stringify({ type: 'terminal_output', text: data.text, isStderr: true }));
    }
  } else if (event.type === 'progress') {
    currentWs.send(JSON.stringify({ type: 'tool_log', text: `[Progress] ${event.label}` }));
  }
});

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Git Assistant Helpers
async function getGitBranch() {
  try {
    const { stdout } = await execAsync('git branch --show-current', { cwd: WORKSPACE_DIR });
    return stdout.trim() || 'main'; // fallback to main if empty but git initialized
  } catch {
    return 'not a git repo';
  }
}

async function getGitStatusFiles() {
  try {
    const { stdout } = await execAsync('git status --short', { cwd: WORKSPACE_DIR });
    const lines = stdout.split('\n').filter(l => l.trim() !== '');
    return lines.map(line => {
      const gitStatusChar = line.substring(0, 2).trim();
      const filePath = line.substring(3).trim();
      let status = 'modified';
      if (gitStatusChar.includes('A') || gitStatusChar.includes('?')) status = 'added';
      else if (gitStatusChar.includes('D')) status = 'deleted';
      return { filePath, status };
    });
  } catch {
    return [];
  }
}

// Predefined agent roles mapper
function resolvePersonaPrompt(persona, customPrompt) {
  if (persona === 'frontend') {
    return `You are a Senior Frontend Engineer and UX Specialist. You write clean, modern, responsive HTML/JS and vanilla CSS using glassmorphism, smooth animations, and harmonious color schemes. Prioritize visual perfection, responsiveness, and accessibility in all edits.`;
  }
  if (persona === 'devops') {
    return `You are a Senior DevOps Engineer and System Administrator. You specialize in Unix scripting, service diagnostics, logs analysis (journalctl, telemetry), and system healing. Ensure commands are optimized, non-interactive, and run safely inside sandbox scopes.`;
  }
  if (persona === 'bughunter') {
    return `You are a Senior QA Automation Engineer and Debugging Expert. You specialize in locating code issues, running and writing test suites, performing RAG search queries to inspect contexts, and fixing codebase errors with minimal footprint.`;
  }
  if (persona === 'custom') {
    return customPrompt || '';
  }
  return undefined; // default general assistant
}

// Secure path validation: prevent file operations outside workspace
function resolveSafePath(relativeOrAbsolutePath) {
  const absolutePath = path.isAbsolute(relativeOrAbsolutePath)
    ? relativeOrAbsolutePath
    : path.join(WORKSPACE_DIR, relativeOrAbsolutePath);
  
  const relative = path.relative(WORKSPACE_DIR, absolutePath);
  if (relative && relative.startsWith('..') && !relative.startsWith('.')) {
    throw new Error('Access denied: Path is outside workspace directory');
  }
  return absolutePath;
}

// Local Vector Database for RAG Context
const vectorDb = [];

async function getEmbedding(text, apiKey) {
  const provider = process.env.ACTIVE_PROVIDER;
  
  // 1. Try NVIDIA embedding if active provider is nvidia
  if (provider === 'nvidia') {
    const key = apiKey || process.env.NVIDIA_API_KEY;
    if (key) {
      try {
        const response = await fetch('https://integrate.api.nvidia.com/v1/embeddings', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${key}`
          },
          body: JSON.stringify({
            input: [text],
            model: 'nvidia/embeddings-nv-embed-qa-4',
            encoding_format: 'float'
          })
        });
        if (response.ok) {
          const resData = await response.json();
          if (resData.data && resData.data[0] && resData.data[0].embedding) {
            return resData.data[0].embedding;
          }
        } else {
          const errMsg = await response.text();
          console.warn('[RAG] NVIDIA embedding API returned error:', errMsg);
        }
      } catch (err) {
        console.warn('[RAG] NVIDIA embedding failed, falling back:', err.message);
      }
    }
  }

  // 2. Try local Ollama embedding endpoint first if provider is ollama or key is missing
  if (provider === 'ollama' || (!apiKey && !process.env.GEMINI_API_KEY && !process.env.NVIDIA_API_KEY)) {
    try {
      const tagsRes = await fetch('http://localhost:11434/api/tags');
      if (tagsRes.ok) {
        const tagsData = await tagsRes.json();
        const models = tagsData.models || [];
        const embedModel = models.find(m => m.name.includes('embed'))?.name || 
                           models.find(m => m.name.includes('coder'))?.name || 
                           (models[0]?.name);
        
        if (embedModel) {
          const embedRes = await fetch('http://localhost:11434/api/embeddings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: embedModel, prompt: text })
          });
          if (embedRes.ok) {
            const embedData = await embedRes.json();
            if (embedData.embedding && Array.isArray(embedData.embedding)) {
              return embedData.embedding;
            }
          }
        }
      }
    } catch (err) {
      console.warn('[RAG] Local Ollama embedding failed, falling back to Gemini:', err.message);
    }
  }

  // 2. Fallback to Gemini embedding
  const key = apiKey || process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error('Gemini API key is not configured for vector embeddings, and local Ollama is offline.');
  }
  const genAI = new GoogleGenerativeAI(key);
  const model = genAI.getGenerativeModel({ model: "embedding-001" }, { apiVersion: "v1" });
  
  let attempts = 0;
  while (attempts < 3) {
    try {
      const result = await model.embedContent(text);
      return result.embedding.values;
    } catch (err) {
      if (err.message.includes('429') || err.message.includes('RESOURCE_EXHAUSTED')) {
        attempts++;
        console.warn(`[RAG] Rate limit hit. Retrying in 15 seconds (attempt ${attempts}/3)...`);
        await new Promise(resolve => setTimeout(resolve, 15000));
      } else {
        throw err;
      }
    }
  }
  throw new Error('Failed to retrieve embedding after 3 retries due to rate limit.');
}

function dotProduct(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) {
    return 0;
  }
  let product = 0;
  for (let i = 0; i < vecA.length; i++) {
    product += vecA[i] * vecB[i];
  }
  return product;
}

async function indexFile(filePath, apiKey) {
  try {
    const fullPath = path.join(WORKSPACE_DIR, filePath);
    const stats = await fs.stat(fullPath);
    
    // Clear existing chunks for this file
    for (let i = vectorDb.length - 1; i >= 0; i--) {
      if (vectorDb[i].filePath === filePath) {
        vectorDb.splice(i, 1);
      }
    }
    
    const content = await fs.readFile(fullPath, 'utf8');
    if (content.includes('\u0000') || content.length > 500000) {
      return; // Skip binary or huge files
    }
    
    const chunkSize = 1500;
    const overlap = 200;
    const chunks = [];
    for (let i = 0; i < content.length; i += chunkSize - overlap) {
      const chunk = content.substring(i, i + chunkSize);
      chunks.push(chunk);
      if (i + chunkSize >= content.length) break;
    }
    
    for (let idx = 0; idx < chunks.length; idx++) {
      const chunkText = chunks[idx];
      const embedding = await getEmbedding(chunkText, apiKey);
      vectorDb.push({
        filePath,
        chunkIndex: idx,
        content: chunkText,
        embedding
      });
    }
    console.log(`[RAG] Indexed file: ${filePath} (${chunks.length} chunks)`);
    await saveVectorDbToDisk();
  } catch (err) {
    console.error(`[RAG] Failed to index file ${filePath}:`, err.message);
  }
}

const getCacheFilePath = () => path.join(WORKSPACE_DIR, '.vip_assistant_rag_cache.json');

async function saveVectorDbToDisk() {
  try {
    const cacheFile = getCacheFilePath();
    const dataToSave = vectorDb.map(item => ({
      filePath: item.filePath,
      chunkIndex: item.chunkIndex,
      content: item.content,
      embedding: item.embedding
    }));
    await fs.writeFile(cacheFile, JSON.stringify(dataToSave, null, 2), 'utf8');
    console.log(`[RAG] Vector database cached to SSD: ${cacheFile}`);
  } catch (err) {
    console.error('[RAG] Failed to save vector database cache:', err.message);
  }
}

async function loadVectorDbFromDisk() {
  try {
    const cacheFile = getCacheFilePath();
    const exists = await fs.access(cacheFile).then(() => true).catch(() => false);
    if (!exists) return false;
    
    const content = await fs.readFile(cacheFile, 'utf8');
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      vectorDb.length = 0;
      vectorDb.push(...parsed);
      console.log(`[RAG] Loaded ${vectorDb.length} chunks from SSD cache.`);
      return true;
    }
  } catch (err) {
    console.warn('[RAG] Failed to load vector database cache:', err.message);
  }
  return false;
}

const IGNORED_EXTENSIONS = ['.zip', '.png', '.jpg', '.jpeg', '.gif', '.pdf', '.tar', '.gz', '.mp3', '.mp4', '.exe', '.bin', '.db', '.sqlite'];

async function indexWorkspace(apiKey) {
  try {
    console.log('[RAG] Checking SSD vector database cache...');
    const loaded = await loadVectorDbFromDisk();
    if (loaded) {
      console.log(`[RAG] Workspace loading complete from SSD cache. Chunks: ${vectorDb.length}`);
      return;
    }
    
    console.log('[RAG] No valid cache found. Indexing workspace files in background...');
    const files = await getWorkspaceFilesRecursive(WORKSPACE_DIR);
    
    const filteredFiles = files.filter(f => {
      const ext = path.extname(f).toLowerCase();
      return !IGNORED_EXTENSIONS.includes(ext);
    });

    console.log(`[RAG] Found ${filteredFiles.length} text files to index.`);
    for (const file of filteredFiles) {
      await indexFile(file, apiKey);
      // Wait 4 seconds between files to prevent 429 quota exhaustion
      await new Promise(resolve => setTimeout(resolve, 4000));
    }
    console.log(`[RAG] Workspace indexing complete. Total indexed chunks: ${vectorDb.length}`);
    await saveVectorDbToDisk();
  } catch (err) {
    console.error('[RAG] Workspace indexing failed:', err.message);
  }
}

async function getWorkspaceFilesRecursive(dir, baseDir = WORKSPACE_DIR) {
  let results = [];
  try {
    const list = await fs.readdir(dir, { withFileTypes: true });
    for (const file of list) {
      const relative = path.relative(baseDir, path.join(dir, file.name));
      if (file.name.startsWith('.') || file.name === 'node_modules' || file.name === 'claude-code-main') {
        continue;
      }
      if (file.isDirectory()) {
        results = results.concat(await getWorkspaceFilesRecursive(path.join(dir, file.name), baseDir));
      } else {
        results.push(relative);
      }
    }
  } catch (err) {
    console.error(`[RAG] Error reading directory ${dir}:`, err.message);
  }
  return results;
}

// Watch workspace for changes and notify clients
let watcher = chokidar.watch(WORKSPACE_DIR, {
  ignored: [/(^|[\/\\])\../, '**/node_modules/**', '**/claude-code-main/**'],
  persistent: true,
  depth: 3,
  ignoreInitial: true
});

watcher.on('all', async (event, filePath) => {
  const relPath = filePath.replace(WORKSPACE_DIR, '').replace(/^[/\\]+/, '');
  
  if (event === 'add' || event === 'change') {
    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey) {
      indexFile(relPath, apiKey);
    }
  } else if (event === 'unlink') {
    for (let i = vectorDb.length - 1; i >= 0; i--) {
      if (vectorDb[i].filePath === relPath) {
        vectorDb.splice(i, 1);
      }
    }
  }

  broadcast({
    type: 'workspace_changed',
    event,
    path: '/' + relPath
  });
});

async function updateWorkspaceDir(newPath) {
  const resolvedPath = path.resolve(newPath);
  const stats = await fs.stat(resolvedPath);
  if (!stats.isDirectory()) {
    throw new Error('Not a directory');
  }

  WORKSPACE_DIR = resolvedPath;

  if (watcher) {
    await watcher.close();
  }

  watcher = chokidar.watch(WORKSPACE_DIR, {
    ignored: [/(^|[\/\\])\../, '**/node_modules/**', '**/claude-code-main/**'],
    persistent: true,
    depth: 3,
    ignoreInitial: true
  });

  watcher.on('all', async (event, filePath) => {
    const relPath = filePath.replace(WORKSPACE_DIR, '').replace(/^[/\\]+/, '');
    
    if (event === 'add' || event === 'change') {
      const apiKey = process.env.GEMINI_API_KEY;
      if (apiKey) {
        indexFile(relPath, apiKey);
      }
    } else if (event === 'unlink') {
      for (let i = vectorDb.length - 1; i >= 0; i--) {
        if (vectorDb[i].filePath === relPath) {
          vectorDb.splice(i, 1);
        }
      }
    }

    broadcast({
      type: 'workspace_changed',
      event,
      path: '/' + relPath
    });
  });

  const apiKey = process.env.GEMINI_API_KEY;
  if (apiKey) {
    indexWorkspace(apiKey);
  }
}

// Rolling Session Audit Log Helper
async function appendSessionLog(entry) {
  try {
    const logPath = path.join(WORKSPACE_DIR, '.vip_assistant_session.log');
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] ${JSON.stringify(entry)}\n`;
    await fs.appendFile(logPath, logLine, 'utf8');
  } catch (err) {
    console.error('Failed to append to session log:', err.message);
  }
}

// Undo History System
const undoStack = [];

function pushToUndoStack(filePath, oldContent) {
  if (undoStack.length >= 50) {
    undoStack.shift();
  }
  undoStack.push({ filePath, oldContent });
}

const wrappedFileWriteTool = {
  ...FileWriteTool,
  async *execute(input, ctx) {
    const abs = path.resolve(ctx.cwd, input.file_path);
    let oldContent = null;
    try {
      oldContent = await fs.readFile(abs, 'utf8');
    } catch (e) {
      // File didn't exist yet
    }
    pushToUndoStack(abs, oldContent);
    yield* FileWriteTool.execute(input, ctx);
  }
};

const wrappedFileEditTool = {
  ...FileEditTool,
  async *execute(input, ctx) {
    const abs = path.resolve(ctx.cwd, input.file_path);
    let oldContent = null;
    try {
      oldContent = await fs.readFile(abs, 'utf8');
    } catch (e) {
      // File didn't exist
    }
    pushToUndoStack(abs, oldContent);
    yield* FileEditTool.execute(input, ctx);
  }
};

// Custom Sandboxed Bash Tool (utilizing Bubblewrap namespaces on Host OS)
const customBashTool = {
  name: "Bash",
  description:
    "Execute a shell command and return stdout/stderr. " +
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
    const BLOCKED = [
      /\brm\s+-rf\s+\/(?:\s|$)/,
      /\bmkfs\b/,
      /\bdd\s+if=.*of=\/dev/,
    ];
    for (const pattern of BLOCKED) {
      if (pattern.test(input.command)) {
        return { valid: false, message: `Command matches blocked pattern: ${pattern}`, code: 403 };
      }
    }
    return { valid: true };
  },

  async checkPermission(input, ctx) {
    if (ctx.permissionMode === "bypassPermissions") return { granted: true };
    const READ_ONLY = /^(cat|head|tail|ls|find|grep|echo|pwd|which|env|git (log|diff|status|show)|wc|sort|uniq)\b/;
    if (READ_ONLY.test(input.command.trimStart())) return { granted: true };
    
    if (!currentWs) {
      return { granted: true };
    }
    
    const toolCallId = `call_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
    
    currentWs.send(JSON.stringify({
      type: 'tool_request',
      toolCallId,
      name: 'Bash',
      args: input,
      autoApprove: false
    }));

    return new Promise((resolve) => {
      pendingApprovals.set(toolCallId, {
        resolve: (approved) => {
          if (approved) {
            resolve({ granted: true });
          } else {
            resolve({ granted: false, reason: "Tool execution was rejected by user." });
          }
        }
      });
    });
  },

  async *execute(input, ctx) {
    const timeout = (input.timeout ?? 120) * 1000;
    yield { type: "progress", data: null, label: input.description ?? input.command };

    const queue = [];
    let resolveNext = null;
    let finished = false;

    // Detect if network is needed for package installers or git remotes
    const requiresNetwork = /\b(npm|yarn|pnpm|pip|pip3|cargo|go\s+get|git\s+(clone|pull|push|fetch)|curl|wget)\b/.test(input.command);
    
    // Construct Bubblewrap sandbox arguments
    const bwrapArgs = [
      '--ro-bind', '/', '/',
      '--bind', WORKSPACE_DIR, WORKSPACE_DIR,
      '--dev', '/dev',
      '--bind', '/tmp', '/tmp',
      '--dir', '/run',
      '--proc', '/proc',
      '--ro-bind', '/sys', '/sys',
      '--chdir', ctx.cwd || WORKSPACE_DIR
    ];
    
    if (!requiresNetwork) {
      bwrapArgs.push('--unshare-net');
    }
    
    bwrapArgs.push('/bin/bash', '-c', input.command);

    const prlimitArgs = [
      '--as=2147483648',       // 2GB virtual memory limit
      '--fsize=524288000',      // 500MB max file size limit
      'bwrap',
      ...bwrapArgs
    ];

    const child = spawn('prlimit', prlimitArgs, {
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

    const timer = setTimeout(() => {
      child.kill();
      error = new Error("Command timed out in sandbox");
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
  }
};

// Custom structured logging retrieval tool
const GetSystemLogsTool = {
  name: "GetSystemLogs",
  description: "Retrieve recent system daemon logs (journalctl) or the agent session audit log containing past tool execution history.",
  inputSchema: {
    type: "object",
    properties: {
      type: { type: "string", enum: ["system", "agent"], description: "Type of logs to retrieve: 'system' for systemd logs, 'agent' for the agent session audit log" },
      limit: { type: "number", description: "Number of log lines to retrieve (default: 30)" }
    },
    required: ["type"]
  },
  validate(input) {
    if (input.limit && input.limit > 200) {
      return { valid: false, message: "Limit cannot exceed 200 lines", code: 400 };
    }
    return { valid: true };
  },
  async checkPermission(input, ctx) {
    return { granted: true };
  },
  async *execute(input, ctx) {
    const limit = input.limit || 30;
    if (input.type === "system") {
      try {
        const { stdout } = await execAsync(`journalctl -n ${limit} --no-pager`);
        return { content: stdout || "(no system logs found)", isError: false };
      } catch (err) {
        return { content: `Failed to fetch system logs: ${err.message}`, isError: true };
      }
    } else {
      try {
        const logPath = path.join(WORKSPACE_DIR, '.vip_assistant_session.log');
        let exists = false;
        try {
          await fs.access(logPath);
          exists = true;
        } catch {}
        
        if (!exists) {
          return { content: "No agent session logs have been written yet.", isError: false };
        }
        
        const content = await fs.readFile(logPath, 'utf8');
        const lines = content.trim().split('\n');
        const tail = lines.slice(-limit).join('\n');
        return { content: tail, isError: false };
      } catch (err) {
        return { content: `Failed to fetch agent logs: ${err.message}`, isError: true };
      }
    }
  }
};

// Custom semantic RAG search tool for workspace context
const SearchProjectContextTool = {
  name: "SearchProjectContext",
  description: "Search workspace codebase and assets using natural language semantic retrieval (RAG). Returns relevant chunks of files with high similarity to the query.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "The natural language search query" },
      limit: { type: "number", description: "Number of relevant chunks to return (default: 5, max: 15)" }
    },
    required: ["query"]
  },
  validate(input) {
    if (!input.query?.trim()) {
      return { valid: false, message: "Query cannot be empty", code: 400 };
    }
    return { valid: true };
  },
  async checkPermission(input, ctx) {
    return { granted: true }; // Read-only query is safe
  },
  async *execute(input, ctx) {
    const limit = input.limit || 5;
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return { content: "Gemini API key is not configured. Cannot perform vector embedding query.", isError: true };
    }
    
    if (vectorDb.length === 0) {
      return { content: "Codebase index is currently empty or still building. Please wait a moment.", isError: false };
    }
    
    try {
      const queryEmbedding = await getEmbedding(input.query, apiKey);
      
      const scored = vectorDb.map(chunk => {
        const score = dotProduct(queryEmbedding, chunk.embedding);
        return { chunk, score };
      });
      
      scored.sort((a, b) => b.score - a.score);
      const top = scored.slice(0, limit);
      
      const formatted = top.map((item, idx) => {
        // ADVANCEMENT 1: Context Window Enrichment (Sliding Window)
        // Find adjacent chunks to give the LLM broader context
        const fileChunks = vectorDb.filter(c => c.filePath === item.chunk.filePath);
        const currIndex = item.chunk.chunkIndex;
        
        let enrichedContent = item.chunk.content;
        const overlap = 200; // As defined in chunking logic
        
        const prevChunk = fileChunks.find(c => c.chunkIndex === currIndex - 1);
        if (prevChunk) {
          // Remove overlap from end of prev chunk
          const trimmedPrev = prevChunk.content.substring(0, prevChunk.content.length - overlap);
          enrichedContent = trimmedPrev + enrichedContent;
        }
        
        const nextChunk = fileChunks.find(c => c.chunkIndex === currIndex + 1);
        if (nextChunk) {
          // Remove overlap from start of next chunk
          const trimmedNext = nextChunk.content.substring(overlap);
          enrichedContent = enrichedContent + trimmedNext;
        }

        return `[Match ${idx + 1}] File: ${item.chunk.filePath} (Similarity: ${item.score.toFixed(3)})\n\`\`\`\n${enrichedContent}\n\`\`\``;
      }).join('\n\n');
      
      return { content: formatted || "No matching code snippets found.", isError: false };
    } catch (err) {
      return { content: `Semantic search failed: ${err.message}`, isError: true };
    }
  }
};

// Helper: Broadcast to all connected WebSocket clients
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(msg);
    }
  });
}

// Fetch local Ollama models list
async function getOllamaModels() {
  try {
    const ollamaHost = process.env.OLLAMA_HOST || 'http://localhost:11434';
    const resp = await fetch(`${ollamaHost.replace(/\/$/, '')}/api/tags`);
    if (resp.ok) {
      const data = await resp.json();
      return (data.models || []).map(m => m.name);
    }
  } catch (e) {
    console.error('Failed to connect to local Ollama:', e.message);
  }
  return [];
}

// Fetch NVIDIA NIM Cloud models list
async function getNvidiaModels(apiKey) {
  try {
    const key = apiKey || process.env.NVIDIA_API_KEY;
    if (!key) return [];
    const resp = await fetch('https://integrate.api.nvidia.com/v1/models', {
      headers: {
        'Authorization': `Bearer ${key}`
      }
    });
    if (resp.ok) {
      const data = await resp.json();
      // Filter out non-chat models or expose all text-generation/chat models
      return (data.data || [])
        .map(m => m.id)
        .filter(id => id.includes('llama') || id.includes('mixtral') || id.includes('gemma') || id.includes('phi') || id.includes('nemotron') || id.includes('mistral'));
    }
  } catch (e) {
    console.error('Failed to fetch NVIDIA Cloud models:', e.message);
  }
  return [];
}

async function runFolderPicker() {
  try {
    const { stdout } = await execAsync(`kdialog --getexistingdirectory "${WORKSPACE_DIR}" --title "Select Workspace Folder"`);
    if (stdout.trim()) {
      return stdout.trim();
    }
  } catch (e) {
    if (e.code === 1) {
      return null;
    }
    // Fallback to zenity
    try {
      const { stdout } = await execAsync(`zenity --file-selection --directory --filename="${WORKSPACE_DIR}/" --title="Select Workspace Folder"`);
      if (stdout.trim()) {
        return stdout.trim();
      }
    } catch (ze) {
      if (ze.code === 1) {
        return null;
      }
      throw new Error(`Directory picker failed: ${ze.message}`);
    }
  }
  return null;
}

// WebSocket Client Manager
wss.on('connection', (ws) => {
  console.log('New WebSocket connection established');
  let agentInstance = null;
  let currentModel = null;
  let currentPermissionMode = null;
  let currentProvider = null;
  let currentSystemPrompt = null;
  
  // Set default client settings and alerts tracking
  ws.clientSettings = { tempAlertThreshold: 85 };
  ws.lastAlerts = { ram: 0, temp: 0, journal: '' };

  // Seed the last journal error so old boot errors don't trigger alerts on connect
  querySystemTelemetry().then(metrics => {
    if (metrics.journalError) {
      ws.lastAlerts.journal = metrics.journalError;
    }
  }).catch(() => {});

  // Send initial workspace info
  Promise.all([
    fs.readdir(WORKSPACE_DIR),
    getOllamaModels(),
    getNvidiaModels(),
    getGitBranch(),
    getGitStatusFiles()
  ]).then(async ([entries, ollamaModels, nvidiaModels, gitBranch, gitModifiedFiles]) => {
    const files = [];
    const dirs = [];
    for (const entry of entries) {
      if (entry.startsWith('.') || entry === 'node_modules') continue;
      try {
        const stats = await fs.stat(path.join(WORKSPACE_DIR, entry));
        if (stats.isDirectory()) {
          dirs.push(entry);
        } else {
          files.push(entry);
        }
      } catch (statErr) {
        console.warn(`Skipping unstatable entry: ${entry} (${statErr.message})`);
      }
    }
    const allFiles = await getWorkspaceFilesRecursive(WORKSPACE_DIR);
    ws.send(JSON.stringify({
      type: 'init_workspace',
      workspace: WORKSPACE_DIR,
      directories: dirs,
      files,
      ollamaModels,
      nvidiaModels,
      gitBranch,
      gitModifiedFiles,
      allFiles
    }));
  }).catch(err => {
    ws.send(JSON.stringify({ type: 'error', message: 'Failed to read workspace root: ' + err.message }));
  });

  // Handle messages from client
  ws.on('message', async (message) => {
    let payload;
    try {
      payload = JSON.parse(message);
    } catch (e) {
      return ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON payload' }));
    }

    const { type } = payload;

    if (type === 'update_settings') {
      ws.clientSettings = { ...ws.clientSettings, ...payload.settings };
      return;
    }

    if (type === 'user_message') {
      const { text, settings } = payload;
      
      // Update global ws pointer for tool callbacks
      currentWs = ws;
      
      try {
        const provider = settings.provider || 'gemini';
        if (process.env.ACTIVE_PROVIDER !== provider) {
          process.env.ACTIVE_PROVIDER = provider;
          vectorDb.length = 0; // Clear RAG cache to prevent vector dimension mismatch crashes
          console.log(`[RAG] Active provider changed to ${provider}. Cleared in-memory vector database.`);
        }
        
        if (provider !== 'ollama') {
          const apiKey = settings.apiKey || (provider === 'gemini' ? process.env.GEMINI_API_KEY : (provider === 'nvidia' ? process.env.NVIDIA_API_KEY : process.env.ANTHROPIC_API_KEY));
          if (!apiKey) {
            return ws.send(JSON.stringify({
              type: 'error',
              message: `${provider === 'gemini' ? 'Gemini' : (provider === 'nvidia' ? 'NVIDIA' : 'Anthropic')} API Key is missing. Please set it in Settings.`
            }));
          }
          if (provider === 'gemini') {
            process.env.GEMINI_API_KEY = apiKey.trim();
          } else if (provider === 'nvidia') {
            process.env.NVIDIA_API_KEY = apiKey.trim();
          } else {
            process.env.ANTHROPIC_API_KEY = apiKey.trim();
          }
          if (vectorDb.length === 0) {
            indexWorkspace(apiKey.trim()).catch(console.error);
          }
        }
        
        const targetModel = provider === 'ollama' ? `ollama/${settings.model}` : (provider === 'nvidia' ? `nvidia/${settings.model}` : settings.model);
        const targetPermissionMode = settings.autoApprove ? 'bypassPermissions' : 'default';
        const targetProvider = provider;
        
        const systemRecoveryPrompt = `
=== SYSTEM SERVICE RECOVERY INSTRUCTION ===
If you receive a system anomaly alert (such as high memory, CPU temperature warnings, or systemd daemon errors):
1. Immediately run non-interactive diagnostics:
   - For high memory: Run \`ps aux --sort=-%mem | head -n 8\` to identify memory-hogging processes.
   - For high CPU temp: Run \`sensors\` or check CPU usage stats using \`ps aux --sort=-%cpu | head -n 8\`.
   - For systemd/crashed services: Run \`systemctl status <service-name>\` or \`systemctl --user status <service-name>\`, and read recent logs with \`journalctl -u <service-name> -n 15 --no-pager\`.
2. Do NOT run interactive commands like \`top\`, \`htop\`, or \`less\`.
3. Present the diagnostic findings clearly, and propose/execute the exact corrective commands (e.g. \`systemctl restart <service>\` or terminating a runaway background process) to recover system stability.
`;

        const targetSystemPrompt = resolvePersonaPrompt(settings.persona, settings.customPrompt);

        // Initialize or re-initialize agent if settings changed
        if (!agentInstance || currentModel !== targetModel || currentPermissionMode !== targetPermissionMode || currentProvider !== targetProvider || currentSystemPrompt !== targetSystemPrompt) {
          ws.send(JSON.stringify({ type: 'tool_log', text: `Initializing Agent Engine (${targetModel})...` }));
          try {
            agentInstance = await createAgent({
              cwd: WORKSPACE_DIR,
              model: targetModel,
              permissionMode: targetPermissionMode,
              systemPrompt: undefined,
              appendSystemPrompt: `${targetSystemPrompt ? targetSystemPrompt : ''}\n\n${systemRecoveryPrompt}`,
              disableBuiltinTools: true,
              tools: [
                customBashTool,
                GetSystemLogsTool,
                SearchProjectContextTool,
                FileReadTool,
                wrappedFileWriteTool,
                wrappedFileEditTool,
                GlobTool,
                GrepTool,
                WebSearchTool
              ]
            });
            currentModel = targetModel;
            currentPermissionMode = targetPermissionMode;
            currentProvider = targetProvider;
            currentSystemPrompt = targetSystemPrompt;
          } catch (err) {
            console.error('Agent creation failed:', err);
            return ws.send(JSON.stringify({
              type: 'error',
              message: `Failed to initialize Agent Engine for ${targetProvider} (${targetModel}): ${err.message}`
            }));
          }
        }
        
        let processedText = text;
        if (payload.mentionFiles && Array.isArray(payload.mentionFiles) && payload.mentionFiles.length > 0) {
          let fileContexts = "\n\n=== ATTACHED FILES FOR CONTEXT ===\n";
          for (const file of payload.mentionFiles) {
            try {
              const content = await fs.readFile(path.join(WORKSPACE_DIR, file), 'utf8');
              fileContexts += `File: ${file}\n\`\`\`\n${content}\n\`\`\`\n\n`;
            } catch (err) {
              console.warn(`Failed to read mention file: ${file}`, err.message);
            }
          }
          processedText += fileContexts;
        }
        
        // Start agent query loop
        runAgentLoop(ws, agentInstance, processedText, settings);
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', message: 'Failed to run agent loop: ' + err.message }));
      }
      
    } else if (type === 'tool_approval') {
      const { approved, toolCallId } = payload;
      const pending = pendingApprovals.get(toolCallId);
      if (pending) {
        pendingApprovals.delete(toolCallId);
        pending.resolve(approved);
      }
      
    } else if (type === 'abort_generation') {
      const controller = activeAborts.get(ws);
      if (controller) {
        controller.abort();
        ws.send(JSON.stringify({ type: 'tool_log', text: 'Generation abort requested by user.' }));
      }
      
    } else if (type === 'get_file_content') {
      const { filePath } = payload;
      try {
        const targetPath = resolveSafePath(filePath);
        const content = await fs.readFile(targetPath, 'utf8');
        ws.send(JSON.stringify({
          type: 'file_content',
          filePath,
          content
        }));
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', message: 'Failed to read file: ' + err.message }));
      }
    } else if (type === 'save_file_content') {
      const { filePath, content } = payload;
      try {
        const targetPath = resolveSafePath(filePath);
        await fs.writeFile(targetPath, content, 'utf8');
        ws.send(JSON.stringify({ type: 'tool_log', text: `Saved file: ${filePath}` }));
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', message: 'Failed to save file: ' + err.message }));
      }
    } else if (type === 'get_git_status') {
      try {
        const gitBranch = await getGitBranch();
        const gitModifiedFiles = await getGitStatusFiles();
        ws.send(JSON.stringify({
          type: 'git_status',
          gitBranch,
          gitModifiedFiles
        }));
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', message: 'Failed to retrieve git status: ' + err.message }));
      }
    } else if (type === 'generate_commit_message') {
      const apiKey = payload.apiKey || process.env.GEMINI_API_KEY;
      if (!apiKey) {
        ws.send(JSON.stringify({ type: 'error', message: 'Gemini API Key is missing. Please configure it in Settings.' }));
      } else {
        try {
          let diff = '';
          try {
            const { stdout } = await execAsync('git diff', { cwd: WORKSPACE_DIR });
            diff = stdout;
          } catch {}
          if (!diff.trim()) {
            try {
              const { stdout } = await execAsync('git diff --cached', { cwd: WORKSPACE_DIR });
              diff = stdout;
            } catch {}
          }
          if (!diff.trim()) {
            try {
              const { stdout } = await execAsync('git status --short', { cwd: WORKSPACE_DIR });
              if (stdout.trim()) {
                diff = `Untracked/Modified files:\n${stdout}`;
              }
            } catch {}
          }
          if (!diff.trim()) {
            ws.send(JSON.stringify({ type: 'error', message: 'No git changes detected to generate message.' }));
          } else {
            const genAI = new GoogleGenerativeAI(apiKey);
            const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
            const promptText = `You are an expert Git commit assistant. Summarize the user's git changes/diff into a professional conventional commit message (e.g. feat(editor): add multi-tab support). Output ONLY the commit message text. Do not include markdown code block formatting or explanation. Keep it concise (under 72 chars).`;
            const result = await model.generateContent([
              { text: promptText },
              { text: `Here is the git diff/status:\n\n${diff.substring(0, 15000)}` }
            ]);
            const commitMessage = result.response.text().trim().replace(/^['"`]+|['"`]+$/g, '');
            ws.send(JSON.stringify({
              type: 'generated_commit_message',
              message: commitMessage
            }));
          }
        } catch (err) {
          ws.send(JSON.stringify({ type: 'error', message: 'Failed to generate commit message: ' + err.message }));
        }
      }
    } else if (type === 'git_commit') {
      const { message } = payload;
      if (!message || !message.trim()) {
        ws.send(JSON.stringify({ type: 'error', message: 'Commit message cannot be empty.' }));
      } else {
        try {
          await execAsync('git add .', { cwd: WORKSPACE_DIR });
          const { stdout } = await execAsync(`git commit -m ${JSON.stringify(message)}`, { cwd: WORKSPACE_DIR });
          ws.send(JSON.stringify({ type: 'tool_log', text: `Git Commit Success:\n${stdout}` }));
          
          const gitBranch = await getGitBranch();
          const gitModifiedFiles = await getGitStatusFiles();
          ws.send(JSON.stringify({
            type: 'git_status',
            gitBranch,
            gitModifiedFiles
          }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'error', message: 'Failed to commit changes: ' + err.message }));
        }
      }
    } else if (type === 'get_file_diff') {
      const { filePath } = payload;
      try {
        let diff = '';
        try {
          const { stdout } = await execAsync(`git diff ${JSON.stringify(filePath)}`, { cwd: WORKSPACE_DIR });
          diff = stdout;
        } catch {}
        if (!diff.trim()) {
          try {
            const { stdout } = await execAsync(`git diff --cached ${JSON.stringify(filePath)}`, { cwd: WORKSPACE_DIR });
            diff = stdout;
          } catch {}
        }
        if (!diff.trim()) {
          try {
            const { stdout } = await execAsync(`git diff --no-index /dev/null ${JSON.stringify(filePath)}`, { cwd: WORKSPACE_DIR });
            diff = stdout;
          } catch {
            try {
              const fullPath = path.join(WORKSPACE_DIR, filePath);
              const content = await fs.readFile(fullPath, 'utf8');
              diff = `+++ b/${filePath}\n@@ -0,0 +1,${content.split('\n').length} @@\n` + content.split('\n').map(l => '+' + l).join('\n');
            } catch {}
          }
        }
        ws.send(JSON.stringify({
          type: 'file_diff',
          filePath,
          diff
        }));
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', message: 'Failed to retrieve diff: ' + err.message }));
      }
    } else if (type === 'get_git_history') {
      try {
        const { stdout } = await execAsync('git log -n 15 --oneline --decorate --format="%h|%s|%an|%ar"', { cwd: WORKSPACE_DIR });
        const commits = stdout.split('\n').filter(l => l.trim() !== '').map(line => {
          const [hash, subject, author, date] = line.split('|');
          return { hash, subject, author, date };
        });
        ws.send(JSON.stringify({
          type: 'git_history',
          commits
        }));
      } catch (err) {
        ws.send(JSON.stringify({ type: 'git_history', commits: [] }));
      }
    } else if (type === 'git_checkout') {
      const { hash } = payload;
      try {
        const { stdout } = await execAsync(`git checkout ${JSON.stringify(hash)}`, { cwd: WORKSPACE_DIR });
        ws.send(JSON.stringify({ type: 'tool_log', text: `Checkout Success:\n${stdout}` }));
        
        const entries = await fs.readdir(WORKSPACE_DIR);
        const files = [];
        const dirs = [];
        for (const entry of entries) {
          if (entry.startsWith('.') || entry === 'node_modules') continue;
          try {
            const stats = await fs.stat(path.join(WORKSPACE_DIR, entry));
            if (stats.isDirectory()) {
              dirs.push(entry);
            } else {
              files.push(entry);
            }
          } catch {}
        }
        const gitBranch = await getGitBranch();
        const gitModifiedFiles = await getGitStatusFiles();
        const allFiles = await getWorkspaceFilesRecursive(WORKSPACE_DIR);
        ws.send(JSON.stringify({
          type: 'init_workspace',
          workspace: WORKSPACE_DIR,
          directories: dirs,
          files,
          ollamaModels: await getOllamaModels(),
          gitBranch,
          gitModifiedFiles,
          allFiles
        }));
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', message: 'Failed to checkout commit: ' + err.message }));
      }
    } else if (type === 'editor_inline_edit') {
      const { filePath, instruction, selectionText, cursorLine, cursorCh } = payload;
      const apiKey = payload.apiKey || process.env.GEMINI_API_KEY;
      const provider = process.env.ACTIVE_PROVIDER || 'gemini';
      
      try {
        const systemPrompt = `You are a precise inline code editor. Your task is to refactor or generate code based on the user's instruction.
Your input is a block of code (context) and an instruction.
You MUST output ONLY the final resulting code. Do NOT wrap your response in markdown code blocks (such as \`\`\`), do NOT explain the changes, and do NOT include any introductory or concluding text.
Your response must be a direct drop-in replacement for the provided code context. If no code was provided as context, generate the code requested by the instruction.`;

        const userPrompt = `Code Context:\n${selectionText || '// (No selection)'}\n\nInstruction:\n${instruction}`;

        let replacement = '';

        if (provider === 'ollama') {
          const activeModel = ws.clientSettings?.model || 'qwen2.5-coder:7b';
          const response = await fetch('http://localhost:11434/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: activeModel,
              prompt: `${systemPrompt}\n\n${userPrompt}`,
              system: systemPrompt,
              stream: false
            })
          });
          if (response.ok) {
            const data = await response.json();
            replacement = data.response;
          } else {
            throw new Error(`Ollama returned status ${response.status}`);
          }
        } else {
          const targetKey = provider === 'gemini' ? process.env.GEMINI_API_KEY : process.env.ANTHROPIC_API_KEY;
          if (!targetKey) {
            throw new Error(`${provider === 'gemini' ? 'Gemini' : 'Anthropic'} API Key is missing.`);
          }
          
          if (provider === 'gemini') {
            const genAI = new GoogleGenerativeAI(targetKey);
            const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
            const result = await model.generateContent([
              { text: systemPrompt },
              { text: userPrompt }
            ]);
            replacement = result.response.text();
          } else {
            const response = await fetch('https://api.anthropic.com/v1/messages', {
              method: 'POST',
              headers: {
                'x-api-key': targetKey,
                'anthropic-version': '2023-06-01',
                'content-type': 'application/json'
              },
              body: JSON.stringify({
                model: 'claude-3-5-sonnet-20240620',
                max_tokens: 4000,
                system: systemPrompt,
                messages: [{ role: 'user', content: userPrompt }]
              })
            });
            if (response.ok) {
              const data = await response.json();
              replacement = data.content[0].text;
            } else {
              throw new Error(`Anthropic returned status ${response.status}`);
            }
          }
        }

        replacement = replacement.replace(/^```[a-zA-Z]*\n?|```$/g, '').trim();

        ws.send(JSON.stringify({
          type: 'inline_edit_result',
          filePath,
          replacement,
          cursorLine,
          cursorCh
        }));

      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', message: 'Inline edit failed: ' + err.message }));
      }
    } else if (type === 'get_code_completion') {
      const { filePath, content, cursorOffset } = payload;
      const provider = process.env.ACTIVE_PROVIDER || 'gemini';
      
      if (provider === 'ollama') {
        try {
          const prefix = content.substring(Math.max(0, cursorOffset - 3000), cursorOffset);
          const suffix = content.substring(cursorOffset, Math.min(content.length, cursorOffset + 1000));
          
          const activeModel = ws.clientSettings?.model || 'qwen2.5-coder:7b';
          const systemPrompt = `You are an AI code completion assistant. Your task is to output the exact code to be inserted at the cursor position (represented by <cursor>). Respond ONLY with the code to be inserted. Do not include markdown code block formatting (like \`\`\`), explanations, or comments unless they are part of the completion. If no completion is appropriate, return an empty string.`;
          const prompt = `File: ${filePath}\n\nCode before cursor:\n${prefix}\n\n<cursor>\n\nCode after cursor:\n${suffix}`;
          
          const response = await fetch('http://localhost:11434/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: activeModel,
              prompt: `${systemPrompt}\n\n${prompt}`,
              system: systemPrompt,
              stream: false
            })
          });
          if (response.ok) {
            const data = await response.json();
            const completion = data.response.trim().replace(/^```[a-zA-Z]*\n?|```$/g, '');
            ws.send(JSON.stringify({
              type: 'code_completion_result',
              filePath,
              completion
            }));
          } else {
            throw new Error(`Ollama returned status ${response.status}`);
          }
        } catch (err) {
          console.error('[Autocomplete] Local completion failed:', err.message);
        }
      } else {
        const apiKey = payload.apiKey || process.env.GEMINI_API_KEY;
        if (!apiKey) {
          ws.send(JSON.stringify({ type: 'error', message: 'Gemini API Key is missing for code completion.' }));
        } else {
          try {
            const prefix = content.substring(Math.max(0, cursorOffset - 3000), cursorOffset);
            const suffix = content.substring(cursorOffset, Math.min(content.length, cursorOffset + 1000));
            
            const genAI = new GoogleGenerativeAI(apiKey);
            const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
            
            const systemPrompt = `You are an AI code completion assistant. Your task is to output the exact code to be inserted at the cursor position (represented by <cursor>). Respond ONLY with the code to be inserted. Do not include markdown code block formatting (like \`\`\`), explanations, or comments unless they are part of the completion. If no completion is appropriate, return an empty string.`;
            
            const result = await model.generateContent([
              { text: systemPrompt },
              { text: `File: ${filePath}\n\nCode before cursor:\n${prefix}\n\n<cursor>\n\nCode after cursor:\n${suffix}` }
            ]);
            
            const completion = result.response.text().trim().replace(/^```[a-zA-Z]*\n?|```$/g, '');
            ws.send(JSON.stringify({
              type: 'code_completion_result',
              filePath,
              completion
            }));
          } catch (err) {
            console.error('[Autocomplete] Failed to generate code completion:', err.message);
          }
        }
      }
    } else if (type === 'narrate_telemetry') {
      const provider = process.env.ACTIVE_PROVIDER || 'gemini';
      
      if (provider === 'ollama') {
        try {
          const activeModel = ws.clientSettings?.model || 'qwen2.5-coder:7b';
          const prompt = `You are a system administrator's GenAI telemetry assistant.
Analyze these current system metrics:
RAM Usage: ${payload.data.ramPercent}%
CPU Temperature: ${payload.data.cpuTemp}°C
Last Critical Log Error: ${payload.data.journalError || 'None'}

Provide a concise, plain-English summary of the system status. Highlight any issues (e.g. memory leak, overheating) or confirm if everything is running optimally. Keep your response under 3 sentences, very professional, and clear.`;

          const response = await fetch('http://localhost:11434/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: activeModel,
              prompt: prompt,
              stream: false
            })
          });
          if (response.ok) {
            const data = await response.json();
            ws.send(JSON.stringify({
              type: 'telemetry_narrative',
              text: data.response
            }));
          } else {
            throw new Error(`Ollama returned status ${response.status}`);
          }
        } catch (err) {
          ws.send(JSON.stringify({
            type: 'telemetry_narrative',
            error: 'Failed to generate local narrative: ' + err.message
          }));
        }
      } else {
        const apiKey = payload.apiKey || process.env.GEMINI_API_KEY;
        if (!apiKey) {
          ws.send(JSON.stringify({
            type: 'telemetry_narrative',
            error: 'Gemini API Key is missing. Please set it in Settings on the main page or in your .env file.'
          }));
        } else {
          try {
            const genAI = new GoogleGenerativeAI(apiKey);
            const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
            
            const prompt = `You are a system administrator's GenAI telemetry assistant.
Analyze these current system metrics:
RAM Usage: ${payload.data.ramPercent}% of 16GB RAM
CPU Temperature: ${payload.data.cpuTemp}°C
Last Critical Log Error: ${payload.data.journalError || 'None'}

Provide a concise, plain-English summary of the system status. Highlight any issues (e.g. memory leak, overheating) or confirm if everything is running optimally. Keep your response under 3 sentences, very professional, and clear.`;
            
            const result = await model.generateContent(prompt);
            const narrative = result.response.text();
            
            ws.send(JSON.stringify({
              type: 'telemetry_narrative',
              text: narrative
            }));
          } catch (err) {
            ws.send(JSON.stringify({
              type: 'telemetry_narrative',
              error: 'Failed to generate narrative: ' + err.message
            }));
          }
        }
      }
    } else if (type === 'fetch_nvidia_models') {
      const apiKey = payload.apiKey || process.env.NVIDIA_API_KEY;
      if (apiKey) {
        getNvidiaModels(apiKey).then(models => {
          ws.send(JSON.stringify({
            type: 'nvidia_models',
            models
          }));
        });
      }
    } else if (type === 'change_workspace') {
      const { path: newPath } = payload;
      try {
        await updateWorkspaceDir(newPath);
        
        const entries = await fs.readdir(WORKSPACE_DIR);
        const files = [];
        const dirs = [];
        for (const entry of entries) {
          if (entry.startsWith('.') || entry === 'node_modules') continue;
          try {
            const stats = await fs.stat(path.join(WORKSPACE_DIR, entry));
            if (stats.isDirectory()) {
              dirs.push(entry);
            } else {
              files.push(entry);
            }
          } catch (statErr) {
            console.warn(`Skipping unstatable entry: ${entry} (${statErr.message})`);
          }
        }
        
        const gitBranch = await getGitBranch();
        const gitModifiedFiles = await getGitStatusFiles();
        const allFiles = await getWorkspaceFilesRecursive(WORKSPACE_DIR);
        ws.send(JSON.stringify({
          type: 'init_workspace',
          workspace: WORKSPACE_DIR,
          directories: dirs,
          files,
          ollamaModels: await getOllamaModels(),
          gitBranch,
          gitModifiedFiles,
          allFiles
        }));
        
        console.log(`Workspace successfully changed to: ${WORKSPACE_DIR}`);
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', message: 'Failed to switch workspace: ' + err.message }));
      }
    } else if (type === 'get_workspace_tree') {
      try {
        const entries = await fs.readdir(WORKSPACE_DIR);
        const files = [];
        const dirs = [];
        for (const entry of entries) {
          if (entry.startsWith('.') || entry === 'node_modules' || entry === 'claude-code-main') continue;
          try {
            const stats = await fs.stat(path.join(WORKSPACE_DIR, entry));
            if (stats.isDirectory()) {
              dirs.push(entry);
            } else {
              files.push(entry);
            }
          } catch (statErr) {
            console.warn(`Skipping unstatable entry: ${entry}`);
          }
        }
        
        const gitBranch = await getGitBranch();
        const gitModifiedFiles = await getGitStatusFiles();
        const allFiles = await getWorkspaceFilesRecursive(WORKSPACE_DIR);
        ws.send(JSON.stringify({
          type: 'init_workspace',
          workspace: WORKSPACE_DIR,
          directories: dirs,
          files,
          ollamaModels: await getOllamaModels(),
          gitBranch,
          gitModifiedFiles,
          allFiles
        }));
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', message: 'Failed to read workspace tree: ' + err.message }));
      }
    } else if (type === 'undo_last_change') {
      if (undoStack.length > 0) {
        const lastChange = undoStack.pop();
        try {
          if (lastChange.oldContent === null) {
            // Delete the newly created file
            await fs.unlink(lastChange.filePath);
            ws.send(JSON.stringify({
              type: 'toast',
              message: `Undo successful: deleted ${path.basename(lastChange.filePath)}`,
              toastType: 'success'
            }));
          } else {
            // Overwrite the file with the old content
            await fs.writeFile(lastChange.filePath, lastChange.oldContent, 'utf8');
            ws.send(JSON.stringify({
              type: 'toast',
              message: `Undo successful: restored ${path.basename(lastChange.filePath)}`,
              toastType: 'success'
            }));
          }
          
          // Re-scan workspace directories and files
          const entries = await fs.readdir(WORKSPACE_DIR);
          const files = [];
          const dirs = [];
          for (const entry of entries) {
            if (entry.startsWith('.') || entry === 'node_modules') continue;
            try {
              const stats = await fs.stat(path.join(WORKSPACE_DIR, entry));
              if (stats.isDirectory()) dirs.push(entry);
              else files.push(entry);
            } catch (statErr) {}
          }
          const gitBranch = await getGitBranch();
          const gitModifiedFiles = await getGitStatusFiles();
          const allFiles = await getWorkspaceFilesRecursive(WORKSPACE_DIR);
          
          ws.send(JSON.stringify({
            type: 'init_workspace',
            workspace: WORKSPACE_DIR,
            directories: dirs,
            files,
            ollamaModels: await getOllamaModels(),
            gitBranch,
            gitModifiedFiles,
            allFiles
          }));
        } catch (err) {
          ws.send(JSON.stringify({
            type: 'toast',
            message: `Undo failed: ${err.message}`,
            toastType: 'error'
          }));
        }
      } else {
        ws.send(JSON.stringify({
          type: 'toast',
          message: 'No changes to undo',
          toastType: 'warning'
        }));
      }
    } else if (type === 'open_folder_picker') {
      try {
        const pathResult = await runFolderPicker();
        if (pathResult) {
          ws.send(JSON.stringify({
            type: 'folder_picker_result',
            path: pathResult
          }));
        }
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', message: 'Failed to open directory dialog: ' + err.message }));
      }
    }
  });
});

// Run Agent Loop using the QueryEngine from agent-core
async function runAgentLoop(ws, agent, userText, settings) {
  ws.send(JSON.stringify({ type: 'status', text: 'VIP Assistant is thinking...' }));
  await appendSessionLog({ event: 'user_message', text: userText });

  try {
    const abortController = new AbortController();
    activeAborts.set(ws, abortController);
    
    // Consume agent generator
    for await (const event of agent.submitMessage(userText, abortController.signal)) {
      
      switch (event.type) {
        case 'content_block_delta':
          ws.send(JSON.stringify({ type: 'assistant_chunk', text: event.delta }));
          break;
          
        case 'tool_use_start':
          ws.send(JSON.stringify({ type: 'tool_log', text: `Invoking tool: ${event.name}` }));
          
          let toolArgs = {};
          if (event.name === 'Bash') {
            const lastMsg = agent.history[agent.history.length - 1];
            const toolUseBlock = lastMsg.content ? lastMsg.content.find(b => b.type === 'tool_use' && b.id === event.toolUseId) : null;
            const command = toolUseBlock ? toolUseBlock.input.command : "command";
            toolArgs = { command };
            ws.send(JSON.stringify({ type: 'terminal_start', command }));
          } else {
            const lastMsg = agent.history[agent.history.length - 1];
            const toolUseBlock = lastMsg.content ? lastMsg.content.find(b => b.type === 'tool_use' && b.id === event.toolUseId) : null;
            toolArgs = toolUseBlock ? toolUseBlock.input : {};
          }
          await appendSessionLog({ event: 'tool_use_start', tool: event.name, args: toolArgs });
          break;
          
        case 'tool_result':
          ws.send(JSON.stringify({ type: 'tool_log', text: `Tool completed: ${event.name}` }));
          
          if (event.name === 'Bash') {
            const exitCode = event.result.isError ? 1 : 0;
            ws.send(JSON.stringify({ type: 'terminal_end', exitCode }));
          }
          await appendSessionLog({ event: 'tool_result', tool: event.name, result: event.result });
          break;
          
        case 'error':
          ws.send(JSON.stringify({ type: 'error', message: event.error.message }));
          await appendSessionLog({ event: 'tool_error', message: event.error.message });
          break;
      }
    }

    // Map history to client structure
    const clientHistory = mapHistoryToClient(agent.history);

    ws.send(JSON.stringify({ type: 'status', text: 'Idle' }));
    ws.send(JSON.stringify({ type: 'loop_finished', history: clientHistory }));
    await appendSessionLog({ event: 'loop_finished' });
    
  } catch (err) {
    ws.send(JSON.stringify({ type: 'status', text: 'Idle' }));
    ws.send(JSON.stringify({ type: 'error', message: err.message }));
    await appendSessionLog({ event: 'loop_error', message: err.message });
  } finally {
    activeAborts.delete(ws);
  }
}

// Helper: Convert agent message history structure into client history structure
function mapHistoryToClient(history) {
  const clientHistory = [];
  for (const msg of history) {
    let contentText = "";
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'text') {
          contentText += block.text;
        } else if (block.type === 'thinking') {
          contentText += `<thinking>\n${block.thinking}\n</thinking>\n`;
        }
      }
    } else if (typeof msg.content === 'string') {
      contentText = msg.content;
    }
    
    if (contentText.trim()) {
      clientHistory.push({
        role: msg.role,
        content: contentText
      });
    }
  }
  return clientHistory;
}

// Proactive Background System Monitoring Daemon
// Proactive Background System Monitoring Daemon
async function querySystemTelemetry() {
  const metrics = {
    ramPercent: 0,
    cpuTemp: 'N/A',
    journalError: ''
  };

  try {
    // 1. RAM Usage check
    const meminfo = await fs.readFile('/proc/meminfo', 'utf8');
    const totalMatch = meminfo.match(/MemTotal:\s+(\d+) kB/);
    const availMatch = meminfo.match(/MemAvailable:\s+(\d+) kB/);
    if (totalMatch && availMatch) {
      const total = parseInt(totalMatch[1], 10);
      const available = parseInt(availMatch[1], 10);
      metrics.ramPercent = Math.round(((total - available) / total) * 100);
    }
  } catch (e) {
    console.error('Telemetry RAM check failed:', e.message);
  }

  try {
    // 2. CPU Temperature check
    const tempRaw = await fs.readFile('/sys/class/thermal/thermal_zone0/temp', 'utf8');
    metrics.cpuTemp = Math.round(parseInt(tempRaw.trim(), 10) / 1000);
  } catch (e) {
    // Try fallback thermal zones
    try {
      const tempRaw = await fs.readFile('/sys/class/thermal/thermal_zone1/temp', 'utf8');
      metrics.cpuTemp = Math.round(parseInt(tempRaw.trim(), 10) / 1000);
    } catch (err) {}
  }

  try {
    // 3. Systemd journalctl error log check
    const { stdout } = await execAsync('journalctl -p 3 -xb -n 1 --no-pager');
    const cleanLog = stdout.trim();
    if (cleanLog && !cleanLog.includes('-- No entries --')) {
      metrics.journalError = cleanLog;
    }
  } catch (e) {
    console.error('Telemetry Journalctl check failed:', e.message);
  }

  return metrics;
}

function startTelemetryDaemon() {
  setInterval(async () => {
    // Only check if we have active WebSocket clients
    if (wss.clients.size === 0) return;

    const metrics = await querySystemTelemetry();
    const now = Date.now();
    const isLoopActive = activeAborts.size > 0;

    await appendSessionLog({ event: 'telemetry_snapshot', data: metrics });

    // Broadcast raw telemetry snapshot to all clients
    broadcast({
      type: 'telemetry_snapshot',
      data: metrics
    });

    wss.clients.forEach((client) => {
      if (client.readyState !== 1) return;
      if (!client.lastAlerts) {
        client.lastAlerts = { ram: 0, temp: 0, journal: '' };
      }
      
      // 1. RAM Alert
      if (metrics.ramPercent > 88 && (now - client.lastAlerts.ram > 5 * 60 * 1000)) {
        client.lastAlerts.ram = now;
        client.send(JSON.stringify({
          type: 'anomaly_alert',
          anomalyType: 'ram',
          description: `Memory saturation is high: ${metrics.ramPercent}% of your RAM is in use.`,
          data: metrics
        }));
      }

      // 2. Temperature Alert
      if (typeof metrics.cpuTemp === 'number') {
        const baseThreshold = client.clientSettings?.tempAlertThreshold || 85;
        const currentThreshold = isLoopActive ? 92 : baseThreshold;
        
        if (metrics.cpuTemp > currentThreshold && (now - client.lastAlerts.temp > 5 * 60 * 1000)) {
          client.lastAlerts.temp = now;
          client.send(JSON.stringify({
            type: 'anomaly_alert',
            anomalyType: 'temp',
            description: isLoopActive 
              ? `High inference temperature warning: Core temperature reached ${metrics.cpuTemp}°C (Threshold: 92°C).`
              : `CPU temperature warning: Core temperature reached ${metrics.cpuTemp}°C (Threshold: ${baseThreshold}°C).`,
            data: metrics
          }));
        }
      }

      // 3. Journal Alert
      if (metrics.journalError && metrics.journalError !== client.lastAlerts.journal) {
        client.lastAlerts.journal = metrics.journalError;
        client.send(JSON.stringify({
          type: 'anomaly_alert',
          anomalyType: 'journal',
          description: `New critical systemd service or system error logged.`,
          data: metrics
        }));
      }
    });
  }, 10000); // Check every 10 seconds
}

// Start Server
server.listen(PORT, () => {
  console.log(`===========================================================`);
  console.log(` VIP Assistant running at: http://localhost:${PORT}`);
  console.log(` Workspace directory: ${WORKSPACE_DIR}`);
  console.log(`===========================================================`);
  startTelemetryDaemon();
});
