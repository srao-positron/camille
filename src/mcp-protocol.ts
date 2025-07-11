/**
 * MCP (Model Context Protocol) implementation
 * Provides a complete implementation of the MCP protocol for CommonJS compatibility
 */

/**
 * MCP Protocol Version
 */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

/**
 * MCP message types
 */
export interface MCPMessage {
  jsonrpc: '2.0';
  id?: string | number;
  method?: string;
  params?: any;
  result?: any;
  error?: MCPError;
}

/**
 * MCP error structure
 */
export interface MCPError {
  code: number;
  message: string;
  data?: any;
}

/**
 * Standard MCP error codes
 */
export const MCPErrorCodes = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

/**
 * MCP server capabilities
 */
export interface MCPCapabilities {
  tools?: boolean;
  resources?: boolean;
  prompts?: boolean;
  logging?: boolean;
}

/**
 * MCP server info
 */
export interface MCPServerInfo {
  name: string;
  version: string;
  description?: string;
}

/**
 * MCP tool definition
 */
export interface MCPTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
}

/**
 * MCP request handler type
 */
export type MCPRequestHandler = (request: MCPMessage) => Promise<any>;

/**
 * Full MCP server implementation
 */
export class MCPProtocolServer {
  private handlers: Map<string, MCPRequestHandler> = new Map();
  private serverInfo: MCPServerInfo;
  private capabilities: MCPCapabilities;
  private tools: Map<string, MCPTool> = new Map();

  constructor(serverInfo: MCPServerInfo, capabilities: MCPCapabilities = { tools: true }) {
    this.serverInfo = serverInfo;
    this.capabilities = capabilities;
    this.setupCoreHandlers();
  }

  /**
   * Sets up core MCP protocol handlers
   */
  private setupCoreHandlers(): void {
    // Initialize handler
    this.handlers.set('initialize', async (request) => {
      return {
        protocolVersion: MCP_PROTOCOL_VERSION,
        serverInfo: this.serverInfo,
        capabilities: this.capabilities
      };
    });

    // List tools handler
    this.handlers.set('tools/list', async (request) => {
      return {
        tools: Array.from(this.tools.values())
      };
    });

    // Call tool handler
    this.handlers.set('tools/call', async (request) => {
      const { name, arguments: args } = request.params || {};
      
      if (!name) {
        throw this.createError(MCPErrorCodes.INVALID_PARAMS, 'Tool name is required');
      }

      const toolHandler = this.handlers.get(`tool:${name}`);
      if (!toolHandler) {
        throw this.createError(MCPErrorCodes.METHOD_NOT_FOUND, `Unknown tool: ${name}`);
      }

      return await toolHandler({ ...request, params: args });
    });

    // Notifications (no response expected)
    this.handlers.set('notifications/initialized', async () => null);
    this.handlers.set('notifications/cancelled', async () => null);
  }

  /**
   * Registers a tool with the server
   */
  public registerTool(tool: MCPTool, handler: (args: any) => Promise<any>): void {
    this.tools.set(tool.name, tool);
    this.handlers.set(`tool:${tool.name}`, async (request) => {
      try {
        return await handler(request.params);
      } catch (error) {
        throw this.createError(
          MCPErrorCodes.INTERNAL_ERROR,
          error instanceof Error ? error.message : 'Tool execution failed'
        );
      }
    });
  }

  /**
   * Sets a custom method handler
   */
  public setMethodHandler(method: string, handler: MCPRequestHandler): void {
    this.handlers.set(method, handler);
  }

  /**
   * Handles incoming MCP messages
   */
  public async handleMessage(message: MCPMessage): Promise<MCPMessage> {
    const fs = require('fs');
    fs.appendFileSync('/tmp/camille-mcp-server.log', 
      `[${new Date().toISOString()}] MCPProtocol.handleMessage: method=${message.method}, id=${message.id}, hasId=${message.id !== undefined && message.id !== null}\n`);
    
    // Validate message structure
    if (!message.jsonrpc || message.jsonrpc !== '2.0') {
      return this.createErrorResponse(
        message.id,
        MCPErrorCodes.INVALID_REQUEST,
        'Invalid JSON-RPC version'
      );
    }

    // Handle notifications (no response)
    if (message.id === undefined && message.method) {
      fs.appendFileSync('/tmp/camille-mcp-server.log', 
        `[${new Date().toISOString()}] Detected as notification (no id)\n`);
      const handler = this.handlers.get(message.method);
      if (handler) {
        try {
          await handler(message);
        } catch (error) {
          console.error(`Notification handler error: ${error}`);
        }
      }
      // No response for notifications
      return null as any;
    }

    // Validate request
    if (!message.method) {
      return this.createErrorResponse(
        message.id,
        MCPErrorCodes.INVALID_REQUEST,
        'Method is required'
      );
    }

    // Find and execute handler
    fs.appendFileSync('/tmp/camille-mcp-server.log', 
      `[${new Date().toISOString()}] Looking for handler: ${message.method}, available: ${Array.from(this.handlers.keys()).join(', ')}\n`);
    
    const handler = this.handlers.get(message.method);
    if (!handler) {
      return this.createErrorResponse(
        message.id,
        MCPErrorCodes.METHOD_NOT_FOUND,
        `Method not found: ${message.method}`
      );
    }

    try {
      const result = await handler(message);
      return {
        jsonrpc: '2.0',
        id: message.id,
        result
      };
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error) {
        return this.createErrorResponse(
          message.id,
          (error as MCPError).code,
          (error as MCPError).message,
          (error as MCPError).data
        );
      }
      
      return this.createErrorResponse(
        message.id,
        MCPErrorCodes.INTERNAL_ERROR,
        error instanceof Error ? error.message : 'Internal error'
      );
    }
  }

  /**
   * Creates an MCP error object
   */
  private createError(code: number, message: string, data?: any): MCPError {
    return { code, message, data };
  }

  /**
   * Creates an error response message
   */
  private createErrorResponse(
    id: string | number | undefined,
    code: number,
    message: string,
    data?: any
  ): MCPMessage {
    return {
      jsonrpc: '2.0',
      id,
      error: { code, message, data }
    };
  }

  /**
   * Processes a raw JSON string and returns the response
   */
  public async processJSON(jsonString: string): Promise<string | null> {
    let message: MCPMessage;
    
    try {
      message = JSON.parse(jsonString);
    } catch (error) {
      const errorResponse = this.createErrorResponse(
        undefined,
        MCPErrorCodes.PARSE_ERROR,
        'Invalid JSON'
      );
      return JSON.stringify(errorResponse);
    }

    const response = await this.handleMessage(message);
    
    // Notifications don't get responses
    if (!response) {
      return null;
    }

    return JSON.stringify(response);
  }
}