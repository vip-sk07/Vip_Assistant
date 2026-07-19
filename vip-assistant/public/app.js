// ==========================================================================
// VIP Assistant - Frontend Controller
// ==========================================================================

// Application State
let ws = null;
let chatHistory = JSON.parse(localStorage.getItem('vip_chat_history')) || [];
let isGenerating = false;
let currentToolApprovalPayload = null;
let editorCMInstance = null;

const state = {
  settings: {
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    apiKey: '',
    autoApprove: true,
    tempAlertThreshold: 85,
    persona: 'default',
    customPrompt: ''
  },
  workspace: '',
  files: [],
  directories: [],
  ollamaModels: [],
  nvidiaModels: [],
  openTabs: [],
  activeTabPath: null
};

// Cache DOM Elements
const elements = {
  welcomeScreen: document.getElementById('welcome-screen'),
  messageList: document.getElementById('message-list'),
  messageInput: document.getElementById('message-input'),
  sendMessageBtn: document.getElementById('send-message-btn'),
  statusDot: document.getElementById('status-dot'),
  statusText: document.getElementById('status-text'),
  activeModelName: document.getElementById('active-model-name'),
  workspacePath: document.getElementById('workspace-path'),
  fileTree: document.getElementById('file-tree'),
  
  // Settings
  settingsModal: document.getElementById('settings-modal'),
  settingsProvider: document.getElementById('settings-provider'),
  settingsModel: document.getElementById('settings-model'),
  settingsApiKey: document.getElementById('settings-api-key'),
  settingsAutoApprove: document.getElementById('settings-auto-approve'),
  settingsTempAlertThreshold: document.getElementById('settings-temp-alert-threshold'),
  settingsWorkspacePath: document.getElementById('settings-workspace-path'),
  settingsPersona: document.getElementById('settings-persona'),
  customPromptGroup: document.getElementById('custom-prompt-group'),
  settingsCustomPrompt: document.getElementById('settings-custom-prompt'),
  saveSettingsBtn: document.getElementById('save-settings-btn'),
  closeSettingsBtn: document.getElementById('close-settings-btn'),
  settingsTriggerBtn: document.getElementById('settings-trigger-btn'),
  fileContentEditor: document.getElementById('file-content-editor'),
  saveFileBtn: document.getElementById('save-file-btn'),
  sidebarOpenFolderBtn: document.getElementById('sidebar-open-folder-btn'),
  openFolderModal: document.getElementById('open-folder-modal'),
  closeFolderModalBtn: document.getElementById('close-folder-modal-btn'),
  confirmOpenFolderBtn: document.getElementById('confirm-open-folder-btn'),
  newWorkspacePathInput: document.getElementById('new-workspace-path-input'),
  browseFolderBtn: document.getElementById('browse-folder-btn'),
  browseSettingsFolderBtn: document.getElementById('browse-settings-folder-btn'),
  
  // Controls
  clearChatBtn: document.getElementById('clear-chat-btn'),
  refreshWsBtn: document.getElementById('refresh-ws-btn'),
  toggleApproveQuick: document.getElementById('toggle-approve-quick'),
  quickApproveStatus: document.getElementById('quick-approve-status'),
  voiceInputBtn: document.getElementById('voice-input-btn'),
  voiceStatus: document.getElementById('voice-status'),
  
  // Terminal overlay
  terminalStreamOverlay: document.getElementById('terminal-stream-overlay'),
  runningCommandText: document.getElementById('running-command-text'),
  terminalOutputContainer: document.getElementById('terminal-output-container'),
  
  // File Editor Panel
  editorPanel: document.getElementById('editor-panel'),
  editorTabsContainer: document.getElementById('editor-tabs-container'),
  editorSaveBtn: document.getElementById('editor-save-btn'),
  editorCloseBtn: document.getElementById('editor-close-btn'),
  fileContentEditor: document.getElementById('file-content-editor'),
  
  // Git Assistant Panel
  gitBranchName: document.getElementById('git-branch-name'),
  gitStatusFiles: document.getElementById('git-status-files'),
  gitCommitMessage: document.getElementById('git-commit-message'),
  gitGenMsgBtn: document.getElementById('git-gen-msg-btn'),
  gitCommitBtn: document.getElementById('git-commit-btn'),
  
  // Editor status selectors
  editorFileInfo: document.getElementById('editor-file-info'),
  editorLintWarning: document.getElementById('editor-lint-warning'),
  
  // Logs & Stats
  activityLogFeed: document.getElementById('activity-log-feed'),
  statProvider: document.getElementById('stat-provider'),
  statConnection: document.getElementById('stat-connection'),
  toast: document.getElementById('toast-notification'),
  toastMessage: document.getElementById('toast-message')
};

// Initialize Application
document.addEventListener('DOMContentLoaded', () => {
  loadSettings();
  renderChatHistory();
  setupEventListeners();
  setupWorkspaceResizer();
  connectWebSocket();
});

// Load Settings from LocalStorage
function loadSettings() {
  const saved = localStorage.getItem('vip_assistant_settings');
  if (saved) {
    try {
      state.settings = { ...state.settings, ...JSON.parse(saved) };
    } catch (e) {
      console.error('Failed to parse settings', e);
    }
  }
  
  // Apply settings to UI
  elements.settingsProvider.value = state.settings.provider;
  
  updateModelDropdownOptions();
  
  elements.settingsModel.value = state.settings.model;
  elements.settingsApiKey.value = state.settings.apiKey;
  elements.settingsAutoApprove.checked = state.settings.autoApprove;
  if (elements.settingsTempAlertThreshold) {
    elements.settingsTempAlertThreshold.value = state.settings.tempAlertThreshold || 85;
  }
  
  elements.settingsPersona.value = state.settings.persona || 'default';
  elements.settingsCustomPrompt.value = state.settings.customPrompt || '';
  toggleCustomPromptVisibility();
  
  updateQuickApproveUI();
  toggleApiKeyInputState();
  elements.activeModelName.textContent = getFriendlyModelName(state.settings.model);
  elements.statProvider.textContent = 
    state.settings.provider === 'gemini' ? 'Gemini' : 
    state.settings.provider === 'anthropic' ? 'Claude' : 'Ollama';
}

// Save Settings to LocalStorage
function saveSettings() {
  state.settings.provider = elements.settingsProvider.value;
  state.settings.model = elements.settingsModel.value;
  state.settings.apiKey = elements.settingsApiKey.value;
  state.settings.autoApprove = elements.settingsAutoApprove.checked;
  if (elements.settingsTempAlertThreshold) {
    state.settings.tempAlertThreshold = parseInt(elements.settingsTempAlertThreshold.value, 10) || 85;
  }
  
  state.settings.persona = elements.settingsPersona.value;
  state.settings.customPrompt = elements.settingsCustomPrompt.value;
  
  localStorage.setItem('vip_assistant_settings', JSON.stringify(state.settings));
  
  updateQuickApproveUI();
  elements.activeModelName.textContent = getFriendlyModelName(state.settings.model);
  elements.statProvider.textContent = 
    state.settings.provider === 'gemini' ? 'Gemini' : 
    state.settings.provider === 'anthropic' ? 'Claude' : 
    state.settings.provider === 'nvidia' ? 'NVIDIA NIM' : 'Ollama';

  if (state.settings.provider === 'nvidia') {
    ws.send(JSON.stringify({
      type: 'fetch_nvidia_models',
      apiKey: state.settings.apiKey
    }));
  }

  syncSettingsToServer();

  const newWorkspacePath = elements.settingsWorkspacePath.value.trim();
  if (newWorkspacePath && newWorkspacePath !== state.workspace) {
    showToast('Switching workspace...');
    ws.send(JSON.stringify({
      type: 'change_workspace',
      path: newWorkspacePath
    }));
  }
  
  showToast('Settings saved successfully');
  elements.settingsModal.classList.add('hidden');
}

function toggleCustomPromptVisibility() {
  if (elements.settingsPersona.value === 'custom') {
    elements.customPromptGroup.classList.remove('hidden');
  } else {
    elements.customPromptGroup.classList.add('hidden');
  }
}

function syncSettingsToServer() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'update_settings',
      settings: state.settings
    }));
  }
}

// Connect to WebSocket Server
function connectWebSocket() {
  updateStatus('offline', 'Connecting...');
  
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;
  
  ws = new WebSocket(wsUrl);
  
  ws.onopen = () => {
    updateStatus('online', 'Connected');
    elements.statConnection.textContent = 'Connected';
    elements.statConnection.className = 'text-success';
    addActivityLog('System connected to backend.', 'system');
    
    const savedWorkspace = localStorage.getItem('vip_assistant_workspace');
    if (savedWorkspace) {
      ws.send(JSON.stringify({
        type: 'change_workspace',
        path: savedWorkspace
      }));
    }
    
    syncSettingsToServer();
  };
  
  ws.onclose = () => {
    updateStatus('offline', 'Disconnected');
    elements.statConnection.textContent = 'Disconnected';
    elements.statConnection.className = 'text-danger';
    addActivityLog('Connection lost. Retrying in 5 seconds...', 'error');
    
    // Auto-reconnect
    setTimeout(connectWebSocket, 5000);
  };
  
  ws.onerror = (err) => {
    console.error('WebSocket Error:', err);
    showToast('Server connection error');
  };
  
  ws.onmessage = (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch (e) {
      console.error('Failed to parse WebSocket message:', e);
      return;
    }
    
    handleServerMessage(payload);
  };
}

// Handle Server Messages
function handleServerMessage(payload) {
  const { type } = payload;
  
  switch (type) {
    case 'init_workspace':
      state.workspace = payload.workspace;
      localStorage.setItem('vip_assistant_workspace', state.workspace);
      elements.workspacePath.textContent = state.workspace;
      elements.workspacePath.title = state.workspace;
      elements.settingsWorkspacePath.value = state.workspace;
      state.ollamaModels = payload.ollamaModels || [];
      state.nvidiaModels = payload.nvidiaModels || [];
      renderFileExplorer(payload.directories, payload.files);
      renderGitStatus(payload.gitBranch, payload.gitModifiedFiles);
      addActivityLog(`Workspace scanned: ${payload.workspace}`, 'system');
      updateModelDropdownOptions();
      break;
      
    case 'workspace_changed':
      addActivityLog(`Workspace file change detected: ${payload.path}`, 'system');
      
      // Check if external edit conflicts with current active tab
      if (state.activeTabPath && (payload.path === '/' + state.activeTabPath || payload.path === state.activeTabPath)) {
        if (!elements.editorPanel.classList.contains('hidden')) {
          showConflictOverlay(state.activeTabPath);
        }
      }
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'get_git_status' }));
        ws.send(JSON.stringify({ type: 'get_workspace_tree' }));
      }
      break;
      
    case 'status':
      if (payload.text.includes('thinking')) {
        updateStatus('thinking', 'Thinking...');
        isGenerating = true;
      } else {
        updateStatus('online', 'Connected');
      }
      break;
      
    case 'assistant_chunk':
      appendAssistantChunk(payload.text);
      break;
      
    case 'tool_request':
      renderToolCallRequest(payload);
      break;
      
    case 'tool_log':
      addActivityLog(payload.text, 'tool');
      break;
      
    case 'terminal_start':
      elements.runningCommandText.textContent = payload.command;
      elements.terminalOutputContainer.textContent = '';
      elements.terminalStreamOverlay.classList.remove('hidden');
      addActivityLog(`Terminal execution started: ${payload.command}`, 'system');
      break;
      
    case 'terminal_output':
      const outputLine = document.createElement('div');
      outputLine.className = 'terminal-line' + (payload.isStderr ? ' error-line' : '');
      outputLine.textContent = payload.text;
      elements.terminalOutputContainer.appendChild(outputLine);
      elements.terminalOutputContainer.scrollTop = elements.terminalOutputContainer.scrollHeight;
      break;
      
    case 'terminal_end':
      addActivityLog(`Terminal execution complete (exit code: ${payload.exitCode})`, 'system');
      setTimeout(() => {
        elements.terminalStreamOverlay.classList.add('hidden');
      }, 3000);
      break;
      
    case 'file_content': {
      const existingTab = state.openTabs.find(t => t.filePath === payload.filePath);
      const fileHash = hashString(payload.content);
      
      if (existingTab) {
        existingTab.content = payload.content;
        existingTab.originalHash = fileHash;
        existingTab.isDirty = false;
      } else {
        state.openTabs.push({
          filePath: payload.filePath,
          content: payload.content,
          originalHash: fileHash,
          isDirty: false
        });
      }
      
      activateTab(payload.filePath);
      break;
    }

    case 'folder_picker_result':
      elements.newWorkspacePathInput.value = payload.path;
      elements.settingsWorkspacePath.value = payload.path;
      showToast(`Selected folder: ${payload.path}`);
      break;
      
    case 'loop_finished':
      chatHistory = payload.history;
      localStorage.setItem('vip_chat_history', JSON.stringify(chatHistory));
      updateGeneratingState(false);
      break;
      
    case 'error':
      showToast(payload.message, 'error');
      addActivityLog(`Error: ${payload.message}`, 'error');
      updateGeneratingState(false);
      break;

    case 'anomaly_alert':
      showAnomalyBanner(payload.description, payload.anomalyType, payload.data);
      break;
      
    case 'git_status':
      renderGitStatus(payload.gitBranch, payload.gitModifiedFiles);
      break;
      
    case 'generated_commit_message':
      if (elements.gitCommitMessage) {
        elements.gitCommitMessage.value = payload.message;
      }
      if (elements.gitGenMsgBtn) {
        elements.gitGenMsgBtn.disabled = false;
        elements.gitGenMsgBtn.innerHTML = '<i class="bx bx-wand"></i> AI Msg';
      }
      showToast('Commit message generated!');
      break;

      
    case 'nvidia_models':
      state.nvidiaModels = payload.models || [];
      updateModelDropdownOptions();
      break;
      
    case 'toast':
      showToast(payload.message, payload.toastType || 'success');
      break;
  }
}

// Render File Explorer Sidebar
function renderFileExplorer(directories, files) {
  elements.fileTree.innerHTML = '';
  
  if (directories.length === 0 && files.length === 0) {
    const emptyLi = document.createElement('li');
    emptyLi.className = 'loading-item';
    emptyLi.textContent = 'Empty directory';
    elements.fileTree.appendChild(emptyLi);
    return;
  }
  
  // Render Directories
  directories.forEach(dir => {
    const li = document.createElement('li');
    const item = document.createElement('div');
    item.className = 'dir-item';
    item.innerHTML = `<i class="bx bxs-folder"></i> ${dir}`;
    // Future expansion: dynamic subtree loading
    li.appendChild(item);
    elements.fileTree.appendChild(li);
  });
  
  // Render Files
  files.forEach(file => {
    const li = document.createElement('li');
    const item = document.createElement('div');
    item.className = 'file-item';
    item.innerHTML = `<i class="bx bxs-file-js"></i> ${file}`;
    item.addEventListener('click', () => {
      const openTab = state.openTabs.find(t => t.filePath === file);
      if (openTab) {
        activateTab(file);
      } else {
        ws.send(JSON.stringify({
          type: 'get_file_content',
          filePath: file
        }));
      }
    });
    li.appendChild(item);
    elements.fileTree.appendChild(li);
  });
}

// Setup Event Listeners
function setupEventListeners() {
  // Input adjustments
  elements.messageInput.addEventListener('input', () => {
    elements.messageInput.style.height = 'auto';
    elements.messageInput.style.height = elements.messageInput.scrollHeight + 'px';
    elements.sendMessageBtn.disabled = !elements.messageInput.value.trim();
  });
  
  elements.messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  
  elements.sendMessageBtn.addEventListener('click', () => {
    if (isGenerating) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'abort_generation' }));
        showToast("Stopping generation...", "warning");
      }
    } else {
      sendMessage();
    }
  });
  
  // Settings Trigger
  const activitySettings = document.getElementById('activity-settings');
  if (activitySettings) {
    activitySettings.addEventListener('click', () => {
      elements.settingsModal.classList.remove('hidden');
    });
  }
  
  elements.settingsTriggerBtn.addEventListener('click', () => {
    elements.settingsModal.classList.remove('hidden');
  });
  
  elements.closeSettingsBtn.addEventListener('click', () => {
    elements.settingsModal.classList.add('hidden');
  });
  
  elements.saveSettingsBtn.addEventListener('click', saveSettings);
  elements.settingsPersona.addEventListener('change', toggleCustomPromptVisibility);
  
  // Undo Triggers
  const handleUndoAction = () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      showToast('Undoing last AI edit...');
      ws.send(JSON.stringify({ type: 'undo_last_change' }));
    } else {
      showToast('Not connected to server', 'error');
    }
  };

  const activityUndo = document.getElementById('activity-undo');
  if (activityUndo) {
    activityUndo.addEventListener('click', handleUndoAction);
  }
  const chatUndoBtn = document.getElementById('chat-undo-btn');
  if (chatUndoBtn) {
    chatUndoBtn.addEventListener('click', handleUndoAction);
  }

  const chatModelSelector = document.getElementById('chat-model-selector');
  if (chatModelSelector) {
    chatModelSelector.addEventListener('change', () => {
      const selectedModel = chatModelSelector.value;
      state.settings.model = selectedModel;
      
      // Determine provider automatically
      if (selectedModel.startsWith('gemini')) {
        state.settings.provider = 'gemini';
      } else if (selectedModel.startsWith('claude')) {
        state.settings.provider = 'anthropic';
      } else if ((state.nvidiaModels && state.nvidiaModels.includes(selectedModel)) || selectedModel.startsWith('meta/llama') || selectedModel.includes('nvidia') || selectedModel.includes('mixtral') || selectedModel.includes('gemma') || selectedModel.includes('phi-3')) {
        state.settings.provider = 'nvidia';
      } else {
        state.settings.provider = 'ollama';
      }
      
      // Sync settings modal inputs
      elements.settingsProvider.value = state.settings.provider;
      updateModelDropdownOptions();
      elements.settingsModel.value = selectedModel;
      
      // Save settings
      localStorage.setItem('vip_assistant_settings', JSON.stringify(state.settings));
      updateQuickApproveUI();
      
      const friendlyName = getFriendlyModelName(selectedModel);
      elements.activeModelName.textContent = friendlyName;
      elements.statProvider.textContent = 
        state.settings.provider === 'gemini' ? 'Gemini' : 
        state.settings.provider === 'anthropic' ? 'Claude' : 
        state.settings.provider === 'nvidia' ? 'NVIDIA NIM' : 'Ollama';
        
      syncSettingsToServer();
      showToast(`Model switched to ${friendlyName}`);
    });
  }

  elements.settingsProvider.addEventListener('change', () => {
    updateModelDropdownOptions();
    toggleApiKeyInputState();
    if (elements.settingsProvider.value === 'nvidia') {
      ws.send(JSON.stringify({
        type: 'fetch_nvidia_models',
        apiKey: elements.settingsApiKey.value
      }));
    }
  });
  
  // Controls
  elements.clearChatBtn.addEventListener('click', () => {
    chatHistory = [];
    localStorage.removeItem('vip_chat_history');
    elements.messageList.innerHTML = '';
    elements.welcomeScreen.classList.remove('hidden');
    showToast('Chat history cleared');
  });
  
  elements.refreshWsBtn.addEventListener('click', () => {
    // Refresh workspace request
    showToast('Refreshing workspace...');
    if (ws && ws.readyState === WebSocket.OPEN) {
      // Re-trigger scanning by triggering connection events or a custom query
      ws.send(JSON.stringify({ type: 'get_workspace_tree' })); // Wait, server just sends on start or FS watcher. Let's force scan in future if needed.
    }
  });
  
  // Voice Input click binding
  if (elements.voiceInputBtn) {
    elements.voiceInputBtn.addEventListener('click', toggleVoiceInput);
  }

  // Quick settings toggle
  elements.toggleApproveQuick.addEventListener('click', () => {
    state.settings.autoApprove = !state.settings.autoApprove;
    localStorage.setItem('vip_assistant_settings', JSON.stringify(state.settings));
    elements.settingsAutoApprove.checked = state.settings.autoApprove;
    updateQuickApproveUI();
    showToast(`Auto-Approve toggled ${state.settings.autoApprove ? 'ON' : 'OFF'}`);
  });
  
  // Editor Close Trigger
  elements.editorCloseBtn.addEventListener('click', () => {
    closeAllTabs();
  });

  // Open Folder Modal Triggers
  elements.sidebarOpenFolderBtn.addEventListener('click', () => {
    elements.newWorkspacePathInput.value = state.workspace;
    elements.openFolderModal.classList.remove('hidden');
    elements.newWorkspacePathInput.focus();
  });
  
  elements.closeFolderModalBtn.addEventListener('click', () => {
    elements.openFolderModal.classList.add('hidden');
  });
  
  elements.confirmOpenFolderBtn.addEventListener('click', () => {
    const newPath = elements.newWorkspacePathInput.value.trim();
    if (newPath) {
      showToast('Switching workspace...');
      ws.send(JSON.stringify({
        type: 'change_workspace',
        path: newPath
      }));
      elements.openFolderModal.classList.add('hidden');
    }
  });
  
  elements.newWorkspacePathInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      elements.confirmOpenFolderBtn.click();
    }
  });

  elements.browseFolderBtn.addEventListener('click', () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'open_folder_picker' }));
    }
  });

  elements.browseSettingsFolderBtn.addEventListener('click', () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'open_folder_picker' }));
    }
  });
  
  // Prompt chips
  document.querySelectorAll('.prompt-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      elements.messageInput.value = chip.getAttribute('data-prompt');
      elements.messageInput.focus();
      elements.messageInput.dispatchEvent(new Event('input'));
    });
  });

  // Editor Save Action
  elements.editorSaveBtn.addEventListener('click', saveActiveFile);

  // Editor keyboard events (Ctrl+S and Tab indentation)
  elements.fileContentEditor.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      saveActiveFile();
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = e.target.selectionStart;
      const end = e.target.selectionEnd;
      e.target.value = e.target.value.substring(0, start) + "    " + e.target.value.substring(end);
      e.target.selectionStart = e.target.selectionEnd = start + 4;
      e.target.dispatchEvent(new Event('input'));
    }
  });

  // Track dirty changes to tab content
  elements.fileContentEditor.addEventListener('input', () => {
    const activeTab = state.openTabs.find(t => t.filePath === state.activeTabPath);
    if (activeTab) {
      activeTab.content = elements.fileContentEditor.value;
      const currentHash = hashString(activeTab.content);
      const isDirty = currentHash !== activeTab.originalHash;
      if (isDirty !== activeTab.isDirty) {
        activeTab.isDirty = isDirty;
        renderTabs();
      }
    }
  });

  // Git Assistant Click Bindings
  if (elements.gitGenMsgBtn) {
    elements.gitGenMsgBtn.addEventListener('click', () => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      elements.gitGenMsgBtn.disabled = true;
      elements.gitGenMsgBtn.innerHTML = '<i class="bx bx-loader-alt bx-spin"></i> Writing...';
      
      ws.send(JSON.stringify({
        type: 'generate_commit_message',
        apiKey: state.settings.apiKey
      }));
    });
  }

  if (elements.gitCommitBtn) {
    elements.gitCommitBtn.addEventListener('click', () => {
      const message = elements.gitCommitMessage.value.trim();
      if (!message) {
        showToast('Please enter or generate a commit message', 'error');
        return;
      }
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      
      elements.gitCommitBtn.disabled = true;
      elements.gitCommitBtn.innerHTML = '<i class="bx bx-loader-alt bx-spin"></i> Committing...';
      
      ws.send(JSON.stringify({
        type: 'git_commit',
        message: message
      }));
    });
  }
}

// Send Message to Server
function sendMessage() {
  const text = elements.messageInput.value.trim();
  if (!text || isGenerating) return;
  
  elements.welcomeScreen.classList.add('hidden');
  
  // Append User message to UI
  appendUserMessage(text);
  
  // Clear input
  elements.messageInput.value = '';
  elements.messageInput.style.height = 'auto';
  updateGeneratingState(true);
  
  // Create empty assistant message bubble for streaming
  createAssistantBubble();
  
  // Send WebSocket payload
  ws.send(JSON.stringify({
    type: 'user_message',
    text,
    history: chatHistory,
    settings: state.settings
  }));
}

// Add user message card to layout
function appendUserMessage(text) {
  const card = document.createElement('div');
  card.className = 'message-bubble user';
  card.textContent = text;
  elements.messageList.appendChild(card);
  elements.messageList.scrollTop = elements.messageList.scrollHeight;
}

function renderChatHistory() {
  elements.messageList.innerHTML = '';
  if (chatHistory && chatHistory.length > 0) {
    elements.welcomeScreen.classList.add('hidden');
    chatHistory.forEach(msg => {
      const card = document.createElement('div');
      card.className = `message-bubble ${msg.role === 'user' ? 'user' : 'assistant'}`;
      if (msg.role === 'user') {
        let contentText = msg.content;
        if (typeof contentText !== 'string' && Array.isArray(msg.content)) {
          contentText = msg.content.map(b => b.text || '').join('\\n');
        }
        card.textContent = contentText;
      } else {
        let contentText = msg.content;
        if (typeof contentText !== 'string' && Array.isArray(msg.content)) {
          contentText = msg.content.map(b => b.text || '').join('\\n');
        }
        card.innerHTML = parseMarkdown(contentText || '');
      }
      elements.messageList.appendChild(card);
    });
    elements.messageList.scrollTop = elements.messageList.scrollHeight;
  } else {
    elements.welcomeScreen.classList.remove('hidden');
  }
}

let activeAssistantBubble = null;
let activeAssistantText = '';

// Create assistant card
function createAssistantBubble() {
  activeAssistantBubble = document.createElement('div');
  activeAssistantBubble.className = 'message-bubble assistant';
  activeAssistantText = '';
  elements.messageList.appendChild(activeAssistantBubble);
  elements.messageList.scrollTop = elements.messageList.scrollHeight;
}

// Stream assistant chunk
function appendAssistantChunk(text) {
  if (!activeAssistantBubble) {
    createAssistantBubble();
  }
  activeAssistantText += text;
  activeAssistantBubble.innerHTML = parseMarkdown(activeAssistantText);
  elements.messageList.scrollTop = elements.messageList.scrollHeight;
}

// Render Tool Call Card
function renderToolCallRequest(payload) {
  const { toolCallId, name, args, autoApprove } = payload;
  
  const card = document.createElement('div');
  card.className = 'tool-card';
  
  const header = document.createElement('div');
  header.className = 'tool-card-header ' + (autoApprove ? 'success' : 'pending');
  header.innerHTML = `<span><i class="bx bx-cog"></i> Tool Request: <strong>${name}</strong></span> 
                      <span>${autoApprove ? 'Auto-Executing' : 'Awaiting Approval'}</span>`;
  
  const body = document.createElement('div');
  body.className = 'tool-card-body';
  
  const desc = document.createElement('p');
  desc.textContent = `The assistant wants to execute local operations with the following inputs:`;
  body.appendChild(desc);
  
  const pre = document.createElement('pre');
  pre.className = 'tool-args-pre';
  pre.textContent = JSON.stringify(args, null, 2);
  body.appendChild(pre);
  
  if (!autoApprove) {
    const actions = document.createElement('div');
    actions.className = 'tool-actions';
    
    const approveBtn = document.createElement('button');
    approveBtn.className = 'tool-approve-btn';
    approveBtn.innerHTML = '<i class="bx bx-check"></i> Approve';
    approveBtn.onclick = () => {
      actions.remove();
      header.className = 'tool-card-header success';
      header.querySelector('span:last-child').textContent = 'Executing...';
      sendApproval(true, toolCallId, name, args);
    };
    
    const denyBtn = document.createElement('button');
    denyBtn.className = 'tool-deny-btn';
    denyBtn.innerHTML = '<i class="bx bx-x"></i> Reject';
    denyBtn.onclick = () => {
      actions.remove();
      header.className = 'tool-card-header error';
      header.querySelector('span:last-child').textContent = 'Rejected';
      sendApproval(false, toolCallId, name, args);
    };
    
    actions.appendChild(approveBtn);
    actions.appendChild(denyBtn);
    body.appendChild(actions);
  }
  
  card.appendChild(header);
  card.appendChild(body);
  
  elements.messageList.appendChild(card);
  elements.messageList.scrollTop = elements.messageList.scrollHeight;
}

// Send tool approval back to server
function sendApproval(approved, toolCallId, name, args) {
  ws.send(JSON.stringify({
    type: 'tool_approval',
    approved,
    toolCallId,
    name,
    args,
    history: chatHistory,
    settings: state.settings
  }));
}

// Simple Activity Logging
function addActivityLog(text, type = 'system') {
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  
  const timestamp = new Date().toLocaleTimeString();
  entry.innerHTML = `<span style="color:var(--text-muted)">[${timestamp}]</span> ${text}`;
  
  elements.activityLogFeed.appendChild(entry);
  elements.activityLogFeed.scrollTop = elements.activityLogFeed.scrollHeight;
}

// Update Status Dot & Text
function updateStatus(stateClass, text) {
  elements.statusDot.className = `status-dot ${stateClass}`;
  elements.statusText.textContent = text;
}

// UI State Toggles
function updateQuickApproveUI() {
  if (state.settings.autoApprove) {
    elements.toggleApproveQuick.classList.add('active');
    elements.quickApproveStatus.textContent = 'ON';
  } else {
    elements.toggleApproveQuick.classList.remove('active');
    elements.quickApproveStatus.textContent = 'OFF';
  }
}

function checkOllamaToolSupport(modelName) {
  const name = modelName.toLowerCase();
  return name.includes('qwen2.5-coder') || name.includes('qwen-coder') || name.includes('command-r');
}

function updateModelDropdownOptions() {
  const provider = elements.settingsProvider.value;
  
  // Remove any previously added Ollama or NVIDIA options
  const optionsToRemove = Array.from(elements.settingsModel.options).filter(o => o.classList.contains('ollama-dynamic-option') || o.classList.contains('nvidia-dynamic-option'));
  optionsToRemove.forEach(o => o.remove());

  if (provider === 'ollama') {
    if (state.ollamaModels && state.ollamaModels.length > 0) {
      state.ollamaModels.forEach(modelName => {
        const opt = document.createElement('option');
        opt.value = modelName;
        const hasTools = checkOllamaToolSupport(modelName);
        opt.textContent = modelName + (hasTools ? ' (Supports Tools)' : ' (No Tool Support - Chat Only)');
        opt.className = 'ollama-dynamic-option';
        elements.settingsModel.appendChild(opt);
      });
    } else {
      const opt = document.createElement('option');
      opt.value = 'llama3:latest';
      opt.textContent = 'llama3:latest (No Tool Support - Chat Only)';
      opt.className = 'ollama-dynamic-option';
      elements.settingsModel.appendChild(opt);
    }
  } else if (provider === 'nvidia') {
    if (state.nvidiaModels && state.nvidiaModels.length > 0) {
      state.nvidiaModels.forEach(modelName => {
        const opt = document.createElement('option');
        opt.value = modelName;
        opt.textContent = modelName;
        opt.className = 'nvidia-dynamic-option';
        elements.settingsModel.appendChild(opt);
      });
    }
  }

  const options = elements.settingsModel.options;
  let firstVisibleSelected = false;
  
  for (let i = 0; i < options.length; i++) {
    const isGemini = options[i].value.startsWith('gemini');
    const isClaude = options[i].value.startsWith('claude');
    const isNvidia = options[i].value.startsWith('meta/llama') || options[i].classList.contains('nvidia-dynamic-option') || options[i].value.includes('nvidia') || options[i].value.includes('mixtral') || options[i].value.includes('gemma') || options[i].value.includes('phi-3');
    const isOllama = options[i].classList.contains('ollama-dynamic-option');
    
    if (provider === 'gemini') {
      if (isGemini) {
        options[i].classList.remove('hidden-option');
        if (!firstVisibleSelected) {
          elements.settingsModel.value = options[i].value;
          firstVisibleSelected = true;
        }
      } else {
        options[i].classList.add('hidden-option');
      }
    } else if (provider === 'anthropic') {
      if (isClaude) {
        options[i].classList.remove('hidden-option');
        if (!firstVisibleSelected) {
          elements.settingsModel.value = options[i].value;
          firstVisibleSelected = true;
        }
      } else {
        options[i].classList.add('hidden-option');
      }
    } else if (provider === 'nvidia') {
      if (isNvidia) {
        options[i].classList.remove('hidden-option');
        if (options[i].value === state.settings.model) {
          elements.settingsModel.value = options[i].value;
          firstVisibleSelected = true;
        }
      } else {
        options[i].classList.add('hidden-option');
      }
    } else if (provider === 'ollama') {
      if (isOllama) {
        options[i].classList.remove('hidden-option');
        if (options[i].value === state.settings.model) {
          elements.settingsModel.value = options[i].value;
          firstVisibleSelected = true;
        }
      } else {
        options[i].classList.add('hidden-option');
      }
    }
  }
  
  if ((provider === 'ollama' || provider === 'nvidia') && !firstVisibleSelected && options.length > 0) {
    for (let i = 0; i < options.length; i++) {
      if (!options[i].classList.contains('hidden-option')) {
        elements.settingsModel.value = options[i].value;
        break;
      }
    }
  }

  // Synchronize chat model selector dropdown options
  const chatModelSelector = document.getElementById('chat-model-selector');
  if (chatModelSelector) {
    chatModelSelector.innerHTML = `
      <optgroup label="Google Gemini" id="chat-group-gemini">
        <option value="gemini-2.5-flash">gemini-2.5-flash</option>
        <option value="gemini-2.5-pro">gemini-2.5-pro</option>
      </optgroup>
      <optgroup label="Anthropic Claude" id="chat-group-claude">
        <option value="claude-3-5-sonnet-20241022">claude-3-5-sonnet-20241022</option>
        <option value="claude-3-7-sonnet-20250219">claude-3-7-sonnet-20250219</option>
      </optgroup>
      <optgroup label="NVIDIA NIM Cloud" id="chat-group-nvidia">
        <option value="meta/llama-3.1-70b-instruct">meta/llama-3.1-70b-instruct (70B)</option>
        <option value="meta/llama-3.1-8b-instruct">meta/llama-3.1-8b-instruct (8B)</option>
      </optgroup>
      <optgroup label="Ollama (Local)" id="chat-group-ollama">
      </optgroup>
    `;
    
    // Add dynamic Ollama models
    const ollamaGroup = chatModelSelector.querySelector('#chat-group-ollama');
    if (ollamaGroup) {
      if (state.ollamaModels && state.ollamaModels.length > 0) {
        state.ollamaModels.forEach(modelName => {
          const opt = document.createElement('option');
          opt.value = modelName;
          opt.textContent = modelName;
          ollamaGroup.appendChild(opt);
        });
      } else {
        const opt = document.createElement('option');
        opt.value = 'llama3:latest';
        opt.textContent = 'llama3:latest';
        ollamaGroup.appendChild(opt);
      }
    }
    
    // Add dynamic NVIDIA models if any additional ones are fetched
    const nvidiaGroup = chatModelSelector.querySelector('#chat-group-nvidia');
    if (nvidiaGroup && state.nvidiaModels && state.nvidiaModels.length > 0) {
      state.nvidiaModels.forEach(modelName => {
        if (modelName !== 'meta/llama-3.1-70b-instruct' && modelName !== 'meta/llama-3.1-8b-instruct') {
          const opt = document.createElement('option');
          opt.value = modelName;
          opt.textContent = modelName;
          nvidiaGroup.appendChild(opt);
        }
      });
    }

    // Set selected value
    chatModelSelector.value = state.settings.model;
  }
}

function toggleApiKeyInputState() {
  const provider = elements.settingsProvider.value;
  if (provider === 'ollama') {
    elements.settingsApiKey.disabled = true;
    elements.settingsApiKey.placeholder = "Not required for local models";
    elements.settingsApiKey.value = "";
  } else {
    elements.settingsApiKey.disabled = false;
    elements.settingsApiKey.placeholder = provider === 'gemini' ? "AIzaSy..." : "sk-...";
    elements.settingsApiKey.value = state.settings.apiKey;
  }
}

// Helper formatting functions
function getFriendlyModelName(model) {
  if (model === 'gemini-1.5-flash') return 'Gemini 1.5 Flash (Deprecated)';
  if (model === 'gemini-1.5-pro') return 'Gemini 1.5 Pro (Deprecated)';
  if (model === 'gemini-2.5-flash') return 'Gemini 2.5 Flash';
  if (model === 'gemini-2.5-pro') return 'Gemini 2.5 Pro';
  if (model === 'claude-3-5-sonnet-20241022') return 'Claude 3.5 Sonnet';
  if (model === 'claude-3-7-sonnet-20250219') return 'Claude 3.7 Sonnet';
  return model;
}

// Toast System
function showToast(message, type = 'success') {
  elements.toastMessage.textContent = message;
  elements.toast.classList.remove('hidden');
  
  if (type === 'error') {
    elements.toast.style.borderColor = 'var(--danger)';
    elements.toast.style.boxShadow = '0 4px 12px rgba(255, 23, 68, 0.2)';
  } else {
    elements.toast.style.borderColor = 'var(--primary-color)';
    elements.toast.style.boxShadow = '0 4px 12px rgba(0, 242, 254, 0.2)';
  }
  
  setTimeout(() => {
    elements.toast.classList.add('hidden');
  }, 3500);
}

// Markdown Parser Helper
function parseMarkdown(markdown) {
  let html = markdown;
  
  // Escape HTML tags to prevent XSS except codes
  html = html.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  
  // Code blocks: ```language ... ```
  html = html.replace(/&lt;!--\s*slide\s*--&gt;/g, ''); // strip slide dividers
  html = html.replace(/```([a-zA-Z0-9+#-]+)?\n([\s\S]+?)\n```/g, (match, lang, code) => {
    return `<pre><code class="language-${lang || 'text'}">${code}</code></pre>`;
  });
  
  // Inline code: `code`
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  
  // Bold text: **text**
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  
  // Italic text: *text*
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  
  // Bullet lists: - item or * item
  html = html.replace(/^\s*[-*]\s+(.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.+<\/li>)+/g, '<ul>$&</ul>');
  
  // Paragraphs (double lines)
  html = html.replace(/\n\n/g, '<br><br>');
  
  return html;
}

// Show Anomaly Banner & Bind Actions
function showAnomalyBanner(description, anomalyType, data) {
  const container = document.getElementById('anomaly-banner-container');
  if (!container) return;

  const card = document.createElement('div');
  card.className = 'anomaly-card';
  
  const icon = anomalyType === 'ram' ? 'bx-chip' : (anomalyType === 'temp' ? 'bx-thermometer' : 'bx-error-alt');
  const title = anomalyType === 'ram' ? 'High Memory Alert' : (anomalyType === 'temp' ? 'High Temperature Warning' : 'Critical System Error Logged');
  
  card.innerHTML = `
    <div class="anomaly-left">
      <div class="anomaly-icon-wrapper">
        <i class="bx ${icon}"></i>
      </div>
      <div class="anomaly-details">
        <span class="anomaly-title">${title}</span>
        <span class="anomaly-desc">${description}</span>
      </div>
    </div>
    <div class="anomaly-actions">
      <button class="anomaly-diagnose-btn"><i class="bx bx-shield-quarter"></i> Diagnose & Fix</button>
      <button class="anomaly-dismiss-btn">Dismiss</button>
    </div>
  `;
  
  container.innerHTML = '';
  container.appendChild(card);
  container.classList.remove('hidden');
  
  showToast(title, 'error');
  addActivityLog(`[SYSTEM ALERT] ${description}`, 'error');
  
  const diagnoseBtn = card.querySelector('.anomaly-diagnose-btn');
  const dismissBtn = card.querySelector('.anomaly-dismiss-btn');
  
  diagnoseBtn.onclick = () => {
    container.classList.add('hidden');
    container.innerHTML = '';
    
    const prompt = `A system anomaly has been detected:\nType: ${title}\nDetails: ${description}\nLive system metrics when triggered: ${JSON.stringify(data)}\n\nPlease run system monitoring/log commands to diagnose the root cause, identify the problematic process or service, and recommend/execute the exact command to resolve it.`;
    
    elements.messageInput.value = prompt;
    elements.messageInput.style.height = 'auto';
    elements.messageInput.style.height = elements.messageInput.scrollHeight + 'px';
    sendMessage();
  };
  
  dismissBtn.onclick = () => {
    container.classList.add('hidden');
    container.innerHTML = '';
  };
}

let recognition = null;
let isListening = false;

function toggleVoiceInput() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    showToast("Voice recognition is not supported in this browser.", "error");
    return;
  }

  if (isListening) {
    if (recognition) {
      recognition.stop();
    }
    return;
  }

  try {
    recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.lang = 'en-US';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      isListening = true;
      elements.voiceInputBtn.classList.add('recording');
      elements.voiceStatus.textContent = 'ON';
      showToast("Listening... Speak now");
      addActivityLog("[SYSTEM] Voice recording started.", "info");
    };

    recognition.onresult = (event) => {
      const text = event.results[0][0].transcript;
      if (text) {
        elements.messageInput.value = text;
        elements.messageInput.style.height = 'auto';
        elements.messageInput.style.height = elements.messageInput.scrollHeight + 'px';
        elements.sendMessageBtn.disabled = false;
        showToast("Voice captured!");
        addActivityLog(`[SYSTEM] Voice dictation: "${text}"`, "info");
      }
    };

    recognition.onerror = (event) => {
      console.error("Speech recognition error", event.error);
      showToast(`Speech recognition error: ${event.error}`, "error");
      stopVoiceRecording();
    };

    recognition.onend = () => {
      stopVoiceRecording();
    };

    recognition.start();

  } catch (err) {
    console.error("Speech recognition initialization failed", err);
    showToast("Failed to initialize voice recognition", "error");
    stopVoiceRecording();
  }
}

function stopVoiceRecording() {
  isListening = false;
  if (elements.voiceInputBtn) {
    elements.voiceInputBtn.classList.remove('recording');
  }
  if (elements.voiceStatus) {
    elements.voiceStatus.textContent = 'OFF';
  }
}

function updateGeneratingState(generating) {
  isGenerating = generating;
  if (generating) {
    elements.messageInput.disabled = true;
    elements.sendMessageBtn.disabled = false;
    elements.sendMessageBtn.classList.add('stop-btn');
    elements.sendMessageBtn.innerHTML = '<i class="bx bx-stop-circle"></i>';
    elements.sendMessageBtn.title = "Stop Generation";
  } else {
    elements.messageInput.disabled = false;
    elements.sendMessageBtn.disabled = !elements.messageInput.value.trim();
    elements.sendMessageBtn.classList.remove('stop-btn');
    elements.sendMessageBtn.innerHTML = '<i class="bx bx-send"></i>';
    elements.sendMessageBtn.title = "Send Message";
    elements.messageInput.focus();
  }
}

function saveActiveFile() {
  if (!state.activeTabPath) return;
  const activeTab = state.openTabs.find(t => t.filePath === state.activeTabPath);
  if (!activeTab) return;
  
  const content = editorCMInstance ? editorCMInstance.getValue() : elements.fileContentEditor.value;
  ws.send(JSON.stringify({
    type: 'save_file_content',
    filePath: state.activeTabPath,
    content: content
  }));
  activeTab.content = content;
  activeTab.originalHash = hashString(content);
  activeTab.isDirty = false;
  renderTabs();
  showToast('File saved successfully');
}

function hashString(str) {
  if (!str) return '0';
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return hash.toString();
}

function showConflictOverlay(filePath) {
  if (elements.editorPanel.querySelector('.conflict-overlay')) return;

  const overlay = document.createElement('div');
  overlay.className = 'conflict-overlay';
  overlay.innerHTML = `
    <h4><i class="bx bx-error-alt"></i> File Changed on Disk</h4>
    <p>The file <strong>${filePath}</strong> has been modified externally. Would you like to reload the changes from disk or keep your current edits?</p>
    <div class="conflict-actions">
      <button class="conflict-btn-reload">Reload from Disk</button>
      <button class="conflict-btn-keep">Keep Local Edits</button>
    </div>
  `;

  overlay.querySelector('.conflict-btn-reload').addEventListener('click', () => {
    overlay.remove();
    ws.send(JSON.stringify({
      type: 'get_file_content',
      filePath: filePath
    }));
  });

  overlay.querySelector('.conflict-btn-keep').addEventListener('click', () => {
    overlay.remove();
    const activeTab = state.openTabs.find(t => t.filePath === filePath);
    if (activeTab) {
      activeTab.originalHash = hashString(activeTab.content);
    }
  });

  elements.editorPanel.appendChild(overlay);
}

// Multi-Tab Editor Helper Functions
function renderTabs() {
  elements.editorTabsContainer.innerHTML = '';
  
  const emptyState = document.getElementById('editor-empty-state');
  const coreContainer = document.getElementById('editor-core-container');
  const saveBtn = document.getElementById('editor-save-btn');
  
  if (state.openTabs.length === 0) {
    if (emptyState) emptyState.classList.remove('hidden');
    if (coreContainer) coreContainer.classList.add('hidden');
    if (saveBtn) saveBtn.style.display = 'none';
    state.activeTabPath = null;
    return;
  }
  
  if (emptyState) emptyState.classList.add('hidden');
  if (coreContainer) coreContainer.classList.remove('hidden');
  if (saveBtn) saveBtn.style.display = 'flex';
  
  state.openTabs.forEach(tab => {
    const tabEl = document.createElement('div');
    tabEl.className = `editor-tab ${tab.filePath === state.activeTabPath ? 'active' : ''} ${tab.isDirty ? 'dirty' : ''}`;
    
    const parts = tab.filePath.split('/');
    const basename = parts[parts.length - 1];
    
    tabEl.innerHTML = `
      <span>${basename}</span>
      <span class="tab-close"><i class="bx bx-x"></i></span>
    `;
    
    tabEl.addEventListener('click', (e) => {
      if (e.target.closest('.tab-close')) {
        closeTab(tab.filePath);
      } else {
        activateTab(tab.filePath);
      }
    });
    
    elements.editorTabsContainer.appendChild(tabEl);
  });
}

function activateTab(filePath) {
  state.activeTabPath = filePath;
  const tab = state.openTabs.find(t => t.filePath === filePath);
  if (tab) {
    elements.editorFileInfo.textContent = filePath;
    hideLintWarning();

    if (typeof CodeMirror !== 'undefined') {
      elements.fileContentEditor.style.display = 'none';

      if (!editorCMInstance) {
        editorCMInstance = CodeMirror.fromTextArea(elements.fileContentEditor, {
          lineNumbers: true,
          theme: 'material-palenight',
          lineWrapping: true,
          indentUnit: 4,
          tabSize: 4
        });

        editorCMInstance.on('change', () => {
          const activeTab = state.openTabs.find(t => t.filePath === state.activeTabPath);
          if (activeTab) {
            activeTab.content = editorCMInstance.getValue();
            const currentHash = hashString(activeTab.content);
            const isDirty = currentHash !== activeTab.originalHash;
            if (isDirty !== activeTab.isDirty) {
              activeTab.isDirty = isDirty;
              renderTabs();
            }
            runSyntaxLint(activeTab.filePath, activeTab.content);
          }
        });

        editorCMInstance.setOption("extraKeys", {
          "Ctrl-S": function() { saveActiveFile(); }
        });
      }

      const ext = filePath.split('.').pop().toLowerCase();
      let mode = 'javascript';
      if (ext === 'css') mode = 'css';
      else if (ext === 'html') mode = 'xml';
      else if (ext === 'md') mode = 'markdown';
      editorCMInstance.setOption('mode', mode);

      editorCMInstance.setValue(tab.content);
      editorCMInstance.clearHistory();
      
      setTimeout(() => {
        editorCMInstance.refresh();
        editorCMInstance.focus();
      }, 50);

      runSyntaxLint(filePath, tab.content);

    } else {
      elements.fileContentEditor.style.display = 'block';
      elements.fileContentEditor.value = tab.content;
      elements.fileContentEditor.disabled = false;
    }

    const existingOverlay = elements.editorPanel.querySelector('.conflict-overlay');
    if (existingOverlay) {
      existingOverlay.remove();
    }
    
    renderTabs();
  }
}

function closeTab(filePath) {
  const index = state.openTabs.findIndex(t => t.filePath === filePath);
  if (index === -1) return;
  
  const tab = state.openTabs[index];
  if (tab.isDirty) {
    const confirmClose = confirm(`File "${filePath}" has unsaved changes. Are you sure you want to close it?`);
    if (!confirmClose) return;
  }
  
  state.openTabs.splice(index, 1);
  
  if (state.activeTabPath === filePath) {
    if (state.openTabs.length > 0) {
      const nextIndex = Math.min(index, state.openTabs.length - 1);
      activateTab(state.openTabs[nextIndex].filePath);
    } else {
      if (editorCMInstance) {
        editorCMInstance.toTextArea();
        editorCMInstance = null;
        elements.fileContentEditor.style.display = 'block';
      }
      state.activeTabPath = null;
      elements.fileContentEditor.value = '';
      elements.fileContentEditor.disabled = true;
      elements.editorFileInfo.textContent = 'Ready';
      hideLintWarning();
      renderTabs();
    }
  } else {
    renderTabs();
  }
}

function closeAllTabs() {
  let dirtyCount = state.openTabs.filter(t => t.isDirty).length;
  if (dirtyCount > 0) {
    const confirmClose = confirm('You have unsaved changes. Are you sure you want to close the editor?');
    if (!confirmClose) return;
  }
  
  if (editorCMInstance) {
    editorCMInstance.toTextArea();
    editorCMInstance = null;
    elements.fileContentEditor.style.display = 'block';
  }

  state.openTabs = [];
  state.activeTabPath = null;
  elements.fileContentEditor.value = '';
  elements.fileContentEditor.disabled = true;
  elements.editorFileInfo.textContent = 'Ready';
  hideLintWarning();
  renderTabs();
}

function renderGitStatus(branch, modifiedFiles) {
  if (!elements.gitBranchName) return; // Exit if git panels are removed
  elements.gitBranchName.textContent = branch || 'not a git repo';
  elements.gitCommitBtn.disabled = false;
  elements.gitCommitBtn.innerHTML = '<i class="bx bx-git-commit"></i> Commit';
  elements.gitStatusFiles.innerHTML = '';
  
  if (branch === 'not a git repo') {
    elements.gitStatusFiles.innerHTML = '<div class="git-status-empty">Not a Git repository.</div>';
    elements.gitCommitMessage.value = '';
    elements.gitCommitMessage.disabled = true;
    elements.gitGenMsgBtn.disabled = true;
    elements.gitCommitBtn.disabled = true;
    return;
  }
  
  if (!modifiedFiles || modifiedFiles.length === 0) {
    elements.gitStatusFiles.innerHTML = '<div class="git-status-empty">No modified files.</div>';
    elements.gitCommitMessage.value = '';
    elements.gitCommitMessage.disabled = true;
    elements.gitGenMsgBtn.disabled = true;
    elements.gitCommitBtn.disabled = true;
    return;
  }
  
  elements.gitCommitMessage.disabled = false;
  elements.gitGenMsgBtn.disabled = false;
  elements.gitCommitBtn.disabled = false;
  
  modifiedFiles.forEach(file => {
    const row = document.createElement('div');
    row.className = 'git-file-row';
    const parts = file.filePath.split('/');
    const basename = parts[parts.length - 1];
    
    row.innerHTML = `
      <span class="git-file-name" title="${file.filePath}">${basename}</span>
      <span class="git-file-status ${file.status}">${file.status}</span>
    `;
    elements.gitStatusFiles.appendChild(row);
  });
}

// AI Autocomplete and Syntax Linting Helpers

function runSyntaxLint(filePath, content) {
  const ext = filePath.split('.').pop().toLowerCase();
  
  if (ext === 'json') {
    try {
      JSON.parse(content);
      hideLintWarning();
    } catch (err) {
      showLintWarning('JSON Syntax: ' + err.message);
    }
  } else if (ext === 'js') {
    try {
      new Function(content);
      hideLintWarning();
    } catch (err) {
      showLintWarning('JS Syntax: ' + err.message);
    }
  } else {
    hideLintWarning();
  }
}

function showLintWarning(message) {
  elements.editorLintWarning.textContent = message;
  elements.editorLintWarning.title = message;
  elements.editorLintWarning.classList.remove('hidden');
}

function hideLintWarning() {
  elements.editorLintWarning.classList.add('hidden');
}

function setupWorkspaceResizer() {
  const resizer = document.getElementById('resizer-bar');
  const editorPanel = document.getElementById('editor-panel');
  const chatPanel = document.getElementById('chat-panel');
  const workspaceLayout = document.getElementById('workspace-layout');
  
  if (!resizer || !editorPanel || !chatPanel || !workspaceLayout) return;
  
  let isDragging = false;
  
  resizer.addEventListener('mousedown', (e) => {
    isDragging = true;
    resizer.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    e.preventDefault();
  });
  
  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    
    const workspaceRect = workspaceLayout.getBoundingClientRect();
    const chatWidth = workspaceRect.right - e.clientX;
    
    if (chatWidth > 260 && chatWidth < 800) {
      chatPanel.style.width = `${chatWidth}px`;
      chatPanel.style.flex = `0 0 ${chatWidth}px`;
      chatPanel.style.minWidth = `${chatWidth}px`;
      chatPanel.style.maxWidth = `${chatWidth}px`;
    }
  });
  
  document.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      resizer.classList.remove('dragging');
      document.body.style.cursor = '';
    }
  });
}
