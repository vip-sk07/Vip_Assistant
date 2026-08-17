#!/usr/bin/env node

/**
 * VIP Assistant - Terminal CLI Client
 * Connects to the VIP Assistant local server backend to run prompts directly from the CLI.
 */

import WebSocket from 'ws';

const prompt = process.argv.slice(2).join(' ');

if (!prompt) {
  console.log(`
\x1b[1m🚀 VIP Assistant CLI\x1b[0m
Usage:
  node vip-cli.js "<your prompt here>"

Examples:
  node vip-cli.js "Create a new addition.py file that adds two numbers"
  node vip-cli.js "Run security check rules on this project"
`);
  process.exit(0);
}

const WS_URL = 'ws://localhost:3000';
console.log(`\x1b[36mConnecting to VIP Assistant at ${WS_URL}...\x1b[0m`);

const ws = new WebSocket(WS_URL);

ws.on('open', () => {
  console.log(`\x1b[32m✔ Connected successfully.\x1b[0m Sending prompt...\n`);
  
  const payload = {
    type: 'user_message',
    text: prompt,
    settings: {
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      autoApprove: true, // Default to autoApprove for CLI runs
      persona: 'default',
      customPrompt: ''
    }
  };
  
  ws.send(JSON.stringify(payload));
});

ws.on('message', (data) => {
  try {
    const msg = JSON.parse(data.toString());
    
    switch (msg.type) {
      case 'assistant_chunk':
        process.stdout.write(msg.text);
        break;
        
      case 'tool_log':
        // Log tool invocations in dim cyan
        console.log(`\n\x1b[2m\x1b[36m⚙ ${msg.text}\x1b[0m`);
        break;
        
      case 'status':
        if (msg.text !== 'Idle') {
          console.log(`\x1b[2m\x1b[33m⏳ Status: ${msg.text}\x1b[0m`);
        }
        break;
        
      case 'loop_finished':
        console.log(`\n\n\x1b[32m✔ Agent run completed successfully.\x1b[0m`);
        ws.close();
        process.exit(0);
        break;
        
      case 'error':
        console.error(`\n\x1b[31m❌ Error: ${msg.message}\x1b[0m`);
        ws.close();
        process.exit(1);
        break;
    }
  } catch (err) {
    console.error('Failed to parse WebSocket message:', err);
  }
});

ws.on('error', (err) => {
  console.error(`\n\x1b[31m❌ Connection Error: ${err.message}\x1b[0m`);
  console.error(`Please verify that the VIP Assistant background service is running:`);
  console.error(`  systemctl --user status vip-assistant.service`);
  process.exit(1);
});

ws.on('close', () => {
  console.log(`\x1b[36mConnection closed.\x1b[0m`);
});
