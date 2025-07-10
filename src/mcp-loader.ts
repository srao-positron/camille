/**
 * MCP loader module for CommonJS compatibility
 * Provides a bridge between our CommonJS project and MCP protocol
 */

import { MCPProtocolServer, MCPTool, MCPMessage } from './mcp-protocol';

/**
 * Interface matching the MCP Server class
 */
export interface MCPServer {
  setRequestHandler(event: string, handler: Function): void;
  handleRequest(message: any): Promise<any>;
}

/**
 * Configuration for MCP server
 */
export interface MCPServerConfig {
  name: string;
  version: string;
  description: string;
}

/**
 * MCP server wrapper using our protocol implementation
 */
export class MCPServerWrapper implements MCPServer {
  private protocolServer: MCPProtocolServer;
  private legacyHandlers: Map<string, Function> = new Map();

  constructor(config: MCPServerConfig) {
    this.protocolServer = new MCPProtocolServer({
      name: config.name,
      version: config.version,
      description: config.description
    });
  }

  /**
   * Sets a request handler for the given event (legacy API)
   */
  setRequestHandler(event: string, handler: Function): void {
    this.legacyHandlers.set(event, handler);
    
    // Convert legacy handlers to protocol handlers
    if (event === 'tools/list') {
      this.protocolServer.setMethodHandler(event, async (message: MCPMessage) => {
        const result = await handler({ params: message.params });
        return result;
      });
    } else if (event === 'tools/call') {
      this.protocolServer.setMethodHandler(event, async (message: MCPMessage) => {
        const result = await handler({ params: message.params });
        return result;
      });
    }
  }

  /**
   * Handles incoming MCP requests
   */
  async handleRequest(message: any): Promise<any> {
    // Ensure message has required JSON-RPC fields
    const mcpMessage: MCPMessage = {
      jsonrpc: '2.0',
      id: message.id || 1,
      method: message.method,
      params: message.params
    };

    const response = await this.protocolServer.handleMessage(mcpMessage);
    
    // Extract result or error for legacy API
    if (response.error) {
      return { error: response.error.message };
    }
    
    return response.result || {};
  }

  /**
   * Registers a tool (for better API)
   */
  registerTool(tool: MCPTool, handler: (args: any) => Promise<any>): void {
    this.protocolServer.registerTool(tool, handler);
  }
}

