/**
 * MCP (Model Context Protocol) server implementation for Camille
 * Provides code search and validation capabilities to Claude
 */

import { MCPServerWrapper, MCPServer } from './mcp-loader';
import { ServerManager } from './server';
import { CamilleHook } from './hook';
import { SearchResult } from './embeddings';
import { OpenAIClient } from './openai-client';
import { ConfigManager } from './config';
import { logger } from './logger';
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import * as os from 'os';

/**
 * MCP tool definitions for Claude
 */
const TOOLS = {
  /**
   * Search for code files using semantic similarity
   */
  searchCode: {
    name: 'camille_search_code',
    description: `Search for code files in the repository using semantic similarity.
    
This tool uses OpenAI embeddings to find files that are semantically similar to your query.
It's particularly useful for finding:
- Files implementing specific functionality
- Code related to certain concepts or features
- Similar code patterns across the codebase
- Files that might be affected by a change

The search returns the most relevant files with similarity scores and summaries.
Higher similarity scores (closer to 1.0) indicate better matches.

IMPORTANT: This tool requires the Camille server to be running with an indexed codebase.
The server must be started with: camille server start --mcp

Example queries:
- "authentication and user login"
- "database connection handling"
- "error logging implementation"
- "API endpoint for user management"
- "functions that validate user input"
- "code that handles file uploads"
- "components that display error messages"`,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural language description of what you are looking for'
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return (default: 10)',
          default: 10
        }
      },
      required: ['query']
    }
  },

  /**
   * Validate code changes for compliance
   */
  validateChanges: {
    name: 'camille_validate_changes',
    description: `Validate proposed code changes against project rules and security best practices.

This tool performs a comprehensive review of code changes including:
- Security vulnerability detection (injection, XSS, authentication flaws, etc.)
- Compliance with CLAUDE.md and development rules
- Code quality and best practices
- Architecture consistency

The tool will automatically read CLAUDE.md and any referenced documentation to ensure
complete compliance checking. It uses GPT-4 for detailed analysis with emphasis on security.

Use this before committing changes to ensure they meet all project standards.`,
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Path to the file being changed'
        },
        changes: {
          type: 'string',
          description: 'The code changes or full new content'
        },
        changeType: {
          type: 'string',
          enum: ['edit', 'create', 'delete'],
          description: 'Type of change being made'
        }
      },
      required: ['filePath', 'changes', 'changeType']
    }
  },

  /**
   * Get Camille server status
   */
  getStatus: {
    name: 'camille_status',
    description: `Get the current status of the Camille server.

Returns information about:
- Whether the server is running
- If indexing is in progress
- Number of files in the index
- Queue size for pending operations

Use this to check if the index is ready before performing searches.`,
    inputSchema: {
      type: 'object',
      properties: {}
    }
  }
};

/**
 * MCP server implementation
 */
export class CamilleMCPServer {
  private server: MCPServer;
  private configManager: ConfigManager;
  private pipePath: string;
  private pipeServer?: net.Server;

  constructor() {
    this.configManager = new ConfigManager();
    this.server = new MCPServerWrapper({
      name: 'camille',
      version: '0.1.0',
      description: 'Intelligent code compliance checker and search tool for Claude Code. Provides semantic code search using OpenAI embeddings and security-focused code validation.'
    });

    // Use named pipe path
    this.pipePath = process.platform === 'win32' 
      ? '\\\\.\\pipe\\camille-mcp'
      : path.join(os.tmpdir(), 'camille-mcp.sock');

    this.setupHandlers();
  }

  /**
   * Sets up MCP handlers
   */
  private setupHandlers(): void {
    // List available tools
    this.server.setRequestHandler('tools/list', async () => ({
      tools: Object.values(TOOLS)
    }));

    // Handle tool calls
    this.server.setRequestHandler('tools/call', async (request: any) => {
      const { name, arguments: args } = request.params;

      switch (name) {
        case 'camille_search_code':
          return await this.handleSearchCode(args);
        case 'camille_validate_changes':
          return await this.handleValidateChanges(args);
        case 'camille_status':
          return await this.handleGetStatus();
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    });
  }

  /**
   * Handles code search requests
   */
  private async handleSearchCode(args: any): Promise<any> {
    const { query, limit = 10 } = args;

    // Check if server is running
    const server = ServerManager.getInstance();
    if (!server) {
      return {
        error: 'Camille server is not running. Start it with "camille server start"'
      };
    }

    const embeddingsIndex = server.getEmbeddingsIndex();
    if (!embeddingsIndex.isIndexReady()) {
      logger.info('Search attempted while index not ready');
      return {
        error: 'Index is still building. Please wait for initial indexing to complete.',
        status: 'indexing',
        hint: 'The server is currently indexing files. This usually takes a few seconds depending on the project size.'
      };
    }

    try {
      // Generate embedding for the query
      const config = this.configManager.getConfig();
      const apiKey = this.configManager.getApiKey();
      const openaiClient = new OpenAIClient(apiKey, config, process.cwd());
      
      const queryEmbedding = await openaiClient.generateEmbedding(query);
      
      // Search the index
      const results = embeddingsIndex.search(queryEmbedding, limit);
      
      // Format results for Claude
      const formattedResults = results.map((result: SearchResult) => ({
        path: path.relative(process.cwd(), result.path),
        similarity: result.similarity.toFixed(3),
        summary: result.summary || 'No summary available',
        preview: result.content.substring(0, 200) + '...'
      }));

      return {
        results: formattedResults,
        totalFiles: embeddingsIndex.getIndexSize()
      };

    } catch (error) {
      return {
        error: `Search failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    }
  }

  /**
   * Handles validation requests
   */
  private async handleValidateChanges(args: any): Promise<any> {
    const { filePath, changes, changeType } = args;

    try {
      const hook = new CamilleHook();
      
      // Format the change for review
      const formattedChange = this.formatChangeForReview(filePath, changes, changeType);
      
      // Create a mock hook input
      const mockInput = {
        session_id: 'mcp-validation',
        transcript_path: '',
        hook_event_name: 'PreToolUse',
        tool: {
          name: changeType === 'create' ? 'Write' : 'Edit',
          input: {
            file_path: filePath,
            ...(changeType === 'create' 
              ? { content: changes }
              : { old_string: '', new_string: changes })
          }
        }
      };

      const result = await hook.processHook(mockInput);

      return {
        approved: result.decision === 'approve',
        reason: result.reason,
        needsChanges: result.decision === 'block',
        details: this.parseValidationDetails(result.reason || '')
      };

    } catch (error) {
      return {
        error: `Validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    }
  }

  /**
   * Handles status requests
   */
  private async handleGetStatus(): Promise<any> {
    const server = ServerManager.getInstance();
    
    if (!server) {
      return {
        running: false,
        message: 'Camille server is not running'
      };
    }

    const status = server.getStatus();
    return {
      running: status.isRunning,
      indexReady: server.getEmbeddingsIndex().isIndexReady(),
      indexing: status.isIndexing,
      filesIndexed: status.indexSize,
      queueSize: status.queueSize
    };
  }

  /**
   * Formats changes for review
   */
  private formatChangeForReview(filePath: string, changes: string, changeType: string): string {
    switch (changeType) {
      case 'create':
        return `Creating new file: ${filePath}\n\nContent:\n${changes}`;
      case 'edit':
        return `Editing file: ${filePath}\n\nChanges:\n${changes}`;
      case 'delete':
        return `Deleting file: ${filePath}`;
      default:
        return changes;
    }
  }

  /**
   * Parses validation details from reason string
   */
  private parseValidationDetails(reason: string): any {
    const details = {
      securityIssues: [] as string[],
      complianceIssues: [] as string[],
      qualityIssues: [] as string[]
    };

    const lines = reason.split('\n');
    for (const line of lines) {
      if (line.includes('Security:')) {
        details.securityIssues.push(line.replace('Security:', '').trim());
      } else if (line.includes('Compliance:')) {
        details.complianceIssues.push(line.replace('Compliance:', '').trim());
      } else if (line.includes('Quality:')) {
        details.qualityIssues.push(line.replace('Quality:', '').trim());
      }
    }

    return details;
  }

  /**
   * Starts the MCP server
   */
  public async start(): Promise<void> {
    // Clean up any existing socket
    if (process.platform !== 'win32' && fs.existsSync(this.pipePath)) {
      fs.unlinkSync(this.pipePath);
    }

    // Create named pipe server
    this.pipeServer = net.createServer((socket) => {
      logger.info('MCP client connected');
      
      socket.on('data', async (data) => {
        try {
          const message = JSON.parse(data.toString());
          const response = await this.server.handleRequest(message);
          socket.write(JSON.stringify(response) + '\n');
        } catch (error) {
          logger.error('MCP error', error);
          const errorMessage = error instanceof Error ? error.message : String(error);
          socket.write(JSON.stringify({ error: errorMessage }) + '\n');
        }
      });

      socket.on('end', () => {
        logger.info('MCP client disconnected');
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.pipeServer!.listen(this.pipePath, (error?: Error) => {
        if (error) {
          reject(error);
        } else {
          logger.info(`MCP server listening on: ${this.pipePath}`);
          resolve();
        }
      });
    });
  }

  /**
   * Stops the MCP server
   */
  public async stop(): Promise<void> {
    if (this.pipeServer) {
      await new Promise<void>((resolve) => {
        this.pipeServer!.close(() => resolve());
      });
      
      // Clean up socket file on Unix
      if (process.platform !== 'win32' && fs.existsSync(this.pipePath)) {
        fs.unlinkSync(this.pipePath);
      }
    }
  }

  /**
   * Gets the pipe path for client configuration
   */
  public getPipePath(): string {
    return this.pipePath;
  }
}