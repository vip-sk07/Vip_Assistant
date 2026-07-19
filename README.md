<div align="center">
  <img src="https://raw.githubusercontent.com/vip-sk07/Vip_Assistant/main/vip-assistant/public/favicon.ico" alt="VIP Assistant Logo" width="120" />
  <h1>✨ VIP Assistant</h1>
  <p><strong>A Sleek, Web-Based Local AI Agent Platform with Advanced RAG Capabilities</strong></p>
  
  [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
  [![Node.js](https://img.shields.io/badge/Node.js-v18+-green.svg)](https://nodejs.org/)
  [![UI: Glassmorphism](https://img.shields.io/badge/UI-Glassmorphism-purple.svg)]()
</div>

<hr />

## 🌟 Project Detail
**VIP Assistant** is a powerful, autonomous AI coding companion and workspace explorer packaged in a stunning, modern web interface. It bridges the gap between massive cloud LLMs (Google Gemini, Anthropic Claude, NVIDIA NIM) and entirely offline, private models (Ollama). 

It is designed to act as a **Senior QA Automation Engineer and Debugging Expert** for your codebase, capable of autonomously reading files, scanning directories, and intelligently retrieving workspace context using an advanced custom-built RAG (Retrieval-Augmented Generation) engine.

### 🎨 The Theme & UI
The frontend features a **premium dark-mode Glassmorphic aesthetic**. 
- **Vibrant & Dynamic:** Neon cyan and purple gradients, frosted glass panels, and smooth micro-animations.
- **Split-Pane Architecture:** Features an interactive Workspace File Explorer on the left and a rich Chat/Agent interface on the right.
- **Real-Time Code Editor:** Built-in Monaco Editor for instant viewing and conflict resolution.

---

## 📸 Screenshots

*(Add your screenshots here by replacing the placeholder links)*
- **Workspace Explorer & Chat Interface:** `![UI Overview](images/screenshot1.png)`
- **Advanced RAG in Action:** `![RAG Search](images/screenshot2.png)`

---

## ⚙️ Features & Detailed Workflow

### 1. Multi-Provider Intelligence
Seamlessly switch between AI brains without restarting the server:
- **Local (Privacy First):** Connects to your local `Ollama` daemon and auto-detects installed models.
- **Cloud (Maximum Power):** Supports `Gemini`, `Anthropic (Claude)`, and `NVIDIA NIM`.

### 2. Advanced RAG (Retrieval-Augmented Generation)
Your codebase is automatically indexed into a fast, local SSD-cached vector database. 
- **Semantic Search:** Ask *"where is the auth logic?"* and the agent retrieves the exact code without keyword matching.
- **Context Window Enrichment:** When the agent retrieves a matching code chunk, it automatically stitches together the chunks immediately before and after it, providing a massive, unbroken context window to prevent hallucinations.
- **Smart Re-indexing:** Switching between Gemini (768 dimensions) and NVIDIA (1024 dimensions) instantly rebuilds the vector database to prevent dimension mismatch crashes.

### 3. File System Autonomy
- Uses a secure `Bubblewrap (bwrap)` sandbox for safely executing bash commands.
- Live `chokidar` file watcher instantly syncs external code edits to your UI.

---

## 🚀 Installation & Instructions

### Prerequisites
- Node.js (v18 or higher)
- API Keys (Optional but recommended: Gemini, Anthropic, NVIDIA)
- Ollama (Optional: for local models)

### Setup
1. **Clone the repository:**
   ```bash
   git clone https://github.com/vip-sk07/Vip_Assistant.git
   cd Vip_Assistant/vip-assistant
   ```

2. **Install Dependencies:**
   ```bash
   npm install
   ```

3. **Build the Agent Core (TypeScript):**
   ```bash
   npm run build
   ```

4. **Environment Variables:**
   Create a `.env` file in the `vip-assistant` directory:
   ```env
   GEMINI_API_KEY=your_google_key
   ANTHROPIC_API_KEY=your_claude_key
   NVIDIA_API_KEY=your_nvidia_key
   ```

5. **Start the Server:**
   ```bash
   npm start
   ```

6. **Access the UI:**
   Open your browser and navigate to `http://localhost:3000`

---

## 🧠 Behind the Scenes (Workflow)
1. **Initialization:** When the server starts, it scans the active workspace and indexes all non-binary files into a vectorized chunk format using the active provider's embedding math.
2. **User Request:** You type a prompt (e.g., *"Fix the bug in the login route"*).
3. **Agent Loop:** The `agent-core` intercepts the prompt. The LLM decides if it needs to use a tool (like `SearchProjectContext`, `ReadFile`, or `RunBash`).
4. **Tool Execution:** The backend securely executes the tool. If RAG is used, it utilizes **Context Window Enrichment** to fetch surrounding code chunks.
5. **Final Output:** The agent streams the final markdown-formatted answer back to the Glassmorphic UI via WebSockets.

---
<div align="center">
  <i>Built for the modern developer workspace.</i>
</div>
