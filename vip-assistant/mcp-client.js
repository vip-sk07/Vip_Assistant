import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'fs/promises';
import path from 'path';

// Store active MCP clients to clean them up later if needed
const activeClients = new Map();

export async function loadMCPServers(workspaceDir) {
  let configPath = path.join(workspaceDir, 'mcp_servers.json');
  let configStr;
  
  try {
    configStr = await fs.readFile(configPath, 'utf8');
  } catch (err) {
    // Fallback to platform root directory configuration
    try {
      configPath = path.join(path.resolve('.'), 'mcp_servers.json');
      configStr = await fs.readFile(configPath, 'utf8');
      console.log(`[MCP] Loading fallback global config from: ${configPath}`);
    } catch (fallbackErr) {
      return [];
    }
  }
  
  let config;
  try {
    config = JSON.parse(configStr);
  } catch (err) {
    console.warn(`[MCP] Failed to parse mcp_servers.json: ${err.message}`);
    return [];
  }
  
  if (!config || !config.mcpServers) {
    return [];
  }
  
  const mcpTools = [];
  
  for (const [serverName, serverConfig] of Object.entries(config.mcpServers)) {
    try {
      console.log(`[MCP] Initializing server: ${serverName}`);
      
      const transport = new StdioClientTransport({
        command: serverConfig.command,
        args: serverConfig.args || [],
        env: { ...process.env, ...(serverConfig.env || {}) }
      });
      
      const client = new Client(
        { name: 'vip-assistant-client', version: '1.0.0' },
        { capabilities: { tools: {} } }
      );
      
      await client.connect(transport);
      activeClients.set(serverName, client);
      
      // Fetch available tools from this MCP server
      const { tools } = await client.listTools();
      if (tools) {
        for (const tool of tools) {
          const safeToolName = tool.name.replace(/[^a-zA-Z0-9_]/g, '_');
          console.log(`[MCP] Registered tool: ${safeToolName} (original: ${tool.name}) from ${serverName}`);
          
          mcpTools.push({
            name: safeToolName,
            description: tool.description || `Tool ${tool.name} from MCP server ${serverName}`,
            inputSchema: tool.inputSchema,
            async checkPermission(input, ctx) {
              return { granted: true };
            },
            async *execute(input, ctx) {
              yield { type: 'progress', data: null, label: `Executing MCP tool ${tool.name}...` };
              try {
                const response = await client.callTool({
                  name: tool.name,
                  arguments: input
                });
                
                let resultText = "";
                if (response.content && Array.isArray(response.content)) {
                  resultText = response.content.map(c => c.text || JSON.stringify(c)).join('\n');
                } else {
                  resultText = JSON.stringify(response);
                }
                
                yield { content: resultText || "(tool executed successfully)", isError: response.isError === true };
              } catch (err) {
                yield { content: `MCP Tool execution failed: ${err.message}`, isError: true };
              }
            }
          });
        }
      }
    } catch (err) {
      console.warn(`[MCP] Failed to initialize server ${serverName}: ${err.message}`);
    }
  }
  
  return mcpTools;
}
