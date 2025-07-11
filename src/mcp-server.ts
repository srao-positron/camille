/**
 * MCP (Model Context Protocol) server implementation for Camille
 * Provides code search and validation capabilities to Claude
 */

import { MCPServerWrapper, MCPServer } from './mcp-loader';
import { ServerManager } from './server';
import { CamilleHook } from './hook';
import { SearchResult } from './embeddings';
import { LLMClient } from './llm-client';
import { ConfigManager } from './config';
import { logger } from './logger';
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import * as os from 'os';

/**
 * MCP tool definitions for Claude
 */
export const TOOLS = {
  /**
   * Search for code files using semantic similarity
   */
  searchCode: {
    name: 'search_code',
    description: `Search for code files in the repository using semantic similarity.

## Overview
This tool uses OpenAI embeddings to find files that are semantically similar to your query.
It searches through the entire indexed codebase and returns the most relevant files based on
conceptual similarity, not just keyword matching.

## When to Use This Tool
1. **Before making changes** - Find all files that might be affected
2. **Understanding the codebase** - Locate implementations of specific features
3. **Finding examples** - Discover how certain patterns are used in the project
4. **Impact analysis** - Identify files that might need updates when changing APIs
5. **Code review preparation** - Find related code to review together

## Integration into Your Workflow
- Always search before creating new files - there might be existing implementations
- Search for related concepts when fixing bugs to find all affected areas
- Use it to understand architectural patterns before making design decisions
- Search for security-sensitive code when reviewing authentication/authorization changes

## Example Queries and Expected Results

### Example 1: Finding authentication code
Query: "authentication and user login"
Expected results:
- Files containing login forms, auth middleware, session management
- JWT token handling, OAuth implementations
- User model with password hashing
- Auth-related API endpoints

### Example 2: Finding error handling
Query: "error handling and logging"
Expected results:
- Global error handlers, try-catch blocks
- Logging utilities and configurations
- Error boundary components (React)
- Custom error classes

### Example 3: Finding data validation
Query: "input validation and sanitization"
Expected results:
- Form validation logic
- API request validators
- Data sanitization functions
- Schema definitions (Joi, Yup, Zod, etc.)

## Example Output
{
  "results": [
    {
      "path": "src/auth/login.ts",
      "similarity": "0.834",
      "summary": "Handles user authentication with JWT tokens, password verification using bcrypt, and session management. Includes rate limiting and failed login tracking.",
      "preview": "export async function login(email: string, password: string) {\\n  const user = await User.findOne({ email });\\n  if (!user || !await bcrypt.compare(password, user.passwordHash)) {\\n    throw new AuthenticationError('Invalid credentials');\\n  }..."
    },
    {
      "path": "src/middleware/auth.ts",
      "similarity": "0.782",
      "summary": "Express middleware for JWT token validation, role-based access control, and API authentication. Handles token refresh and revocation.",
      "preview": "export const requireAuth = async (req, res, next) => {\\n  const token = req.headers.authorization?.split(' ')[1];\\n  if (!token) return res.status(401).json({ error: 'No token provided' });..."
    }
  ],
  "totalFiles": 127,
  "indexStatus": {
    "ready": true,
    "filesIndexed": 127,
    "isIndexing": false
  }
}

## Pro Tips
- Use conceptual queries rather than exact function names
- Combine related concepts with "and" for better results
- Results are sorted by similarity score (0-1, higher is better)
- Check multiple results as related code might be spread across files
- The summary provides context without opening the file
- Use the preview to quickly assess if the file is relevant`,
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
        },
        responseFormat: {
          type: 'string',
          enum: ['json', 'text', 'both'],
          description: 'Format for the response: json (raw data), text (formatted summary), both (default)',
          default: 'both'
        }
      },
      required: ['query']
    }
  },

  /**
   * Validate code changes for compliance
   */
  validateChanges: {
    name: 'validate_code',
    description: `Validate proposed code changes against project rules and security best practices.

## Overview
This tool performs AI-powered code review focusing on security vulnerabilities, compliance with
project standards (CLAUDE.md), and code quality. It uses GPT-4 to analyze changes in context
and provide actionable feedback before committing.

## When to Use This Tool
1. **Before every commit** - Catch security issues and bugs early
2. **After significant refactoring** - Ensure architectural consistency
3. **When adding external dependencies** - Check for security implications
4. **Creating new API endpoints** - Validate authentication and input handling
5. **Modifying security-sensitive code** - Get thorough security review
6. **Before pull requests** - Pre-review to save reviewer time

## Integration into Your Workflow
- Run validation after making changes but before committing
- Use it as a learning tool to understand project standards
- Include validation results in pull request descriptions
- Run on critical files even without changes to audit security
- Use for onboarding to understand codebase standards

## What It Checks

### Security Vulnerabilities
- SQL/NoSQL injection vulnerabilities
- Cross-site scripting (XSS) risks
- Authentication and authorization flaws
- Insecure direct object references
- Security misconfiguration
- Sensitive data exposure
- Using components with known vulnerabilities
- Insufficient logging and monitoring

### Project Compliance
- Adherence to CLAUDE.md rules
- Following established patterns
- Consistent error handling
- Proper TypeScript usage
- Documentation requirements
- Testing requirements

### Code Quality
- Complexity and maintainability
- Performance implications
- Proper async/await usage
- Resource cleanup
- Error handling completeness

## Example Usage and Outputs

### Example 1: SQL Injection Vulnerability
Input:
{
  "filePath": "src/api/users.ts",
  "changes": "const query = \`SELECT * FROM users WHERE id = '\${userId}'\`;\\ndb.query(query);",
  "changeType": "edit"
}

Output:
{
  "approved": false,
  "reason": "CRITICAL SECURITY ISSUE: SQL Injection vulnerability detected",
  "needsChanges": true,
  "details": {
    "securityIssues": [
      "Direct string interpolation in SQL query creates SQL injection vulnerability",
      "User input 'userId' is not sanitized or parameterized",
      "Attacker could execute arbitrary SQL commands"
    ],
    "complianceIssues": [
      "Violates CLAUDE.md rule: 'Always use parameterized queries'"
    ],
    "suggestedFix": "Use parameterized query: db.query('SELECT * FROM users WHERE id = ?', [userId])"
  }
}

### Example 2: Missing Authentication
Input:
{
  "filePath": "src/api/admin.ts",
  "changes": "router.post('/admin/users', async (req, res) => {\\n  const user = await User.create(req.body);\\n  res.json(user);\\n});",
  "changeType": "create"
}

Output:
{
  "approved": false,
  "reason": "SECURITY: Missing authentication and authorization checks",
  "needsChanges": true,
  "details": {
    "securityIssues": [
      "Admin endpoint lacks authentication middleware",
      "No authorization check for admin role",
      "No input validation on req.body",
      "Potential mass assignment vulnerability"
    ],
    "suggestedFix": "Add requireAuth and requireRole('admin') middleware, validate input schema"
  }
}

### Example 3: Good Code
Input:
{
  "filePath": "src/utils/sanitize.ts",
  "changes": "export function sanitizeHtml(input: string): string {\\n  return DOMPurify.sanitize(input, { ALLOWED_TAGS: ['b', 'i', 'em', 'strong'] });\\n}",
  "changeType": "create"
}

Output:
{
  "approved": true,
  "reason": "Code follows security best practices",
  "needsChanges": false,
  "details": {
    "securityIssues": [],
    "complianceIssues": [],
    "positives": [
      "Proper HTML sanitization using DOMPurify",
      "Restrictive allowlist of HTML tags",
      "TypeScript typing for safety"
    ]
  }
}

## Pro Tips
- Always provide full file content for new files
- Include surrounding context for edits when possible
- Run on security-critical files regularly
- Review the detailed feedback to learn patterns
- Use suggested fixes as starting points
- Combine with search tool to find similar patterns`,
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
        },
        responseFormat: {
          type: 'string',
          enum: ['json', 'text', 'both'],
          description: 'Format for the response: json (raw data), text (formatted summary), both (default)',
          default: 'both'
        }
      },
      required: ['filePath', 'changes', 'changeType']
    }
  },

  /**
   * Get Camille server status
   */
  getStatus: {
    name: 'server_status',
    description: `Get the current status of the Camille server.

## Overview
This tool provides real-time information about the Camille server's state, including indexing
progress, readiness for searches, and system health. Use it to ensure the server is ready
before performing operations or to debug issues.

## When to Use This Tool
1. **Before searching** - Ensure index is ready for accurate results
2. **After server start** - Monitor indexing progress
3. **Debugging issues** - Check if server is running and healthy
4. **Performance monitoring** - Track index size and queue status
5. **CI/CD pipelines** - Wait for server readiness before tests

## Integration into Your Workflow
- Always check status when Claude Code session starts
- Poll status after file changes to know when re-indexing completes
- Use before search operations to ensure complete results
- Include status checks in automated scripts
- Monitor during large refactoring operations

## Response Fields Explained

### running (boolean)
- true: Server is active and processing requests
- false: Server is stopped or crashed

### indexReady (boolean)
- true: Initial indexing complete, searches will be accurate
- false: Still indexing, search results may be incomplete

### indexing (boolean)
- true: Currently processing files (initial or updates)
- false: No active indexing operations

### filesIndexed (number)
- Total number of files in the searchable index
- Helps verify expected codebase coverage

### queueSize (number)
- Number of files waiting to be indexed
- High numbers indicate heavy processing load

## Example Outputs

### Example 1: Server Starting Up
{
  "running": true,
  "indexReady": false,
  "indexing": true,
  "filesIndexed": 45,
  "queueSize": 82
}
Interpretation: Server is running but still doing initial indexing. 45 files done, 82 queued.

### Example 2: Server Ready
{
  "running": true,
  "indexReady": true,
  "indexing": false,
  "filesIndexed": 127,
  "queueSize": 0
}
Interpretation: Server fully ready. All 127 files indexed, no pending work.

### Example 3: Processing Updates
{
  "running": true,
  "indexReady": true,
  "indexing": true,
  "filesIndexed": 125,
  "queueSize": 3
}
Interpretation: Server is ready but processing 3 file changes. Searches remain accurate.

### Example 4: Server Not Running
{
  "error": "Camille server is not running. Start with: camille server start"
}
Interpretation: Server needs to be started before using other tools.

## Workflow Examples

### Wait for Server Ready
// Poll until index is ready
let status;
do {
  status = await camille_status();
  if (!status.indexReady) {
    console.log(\`Indexing progress: \${status.filesIndexed} files completed...\`);
    await sleep(2000);
  }
} while (!status.indexReady);

### Health Check Function
async function checkCamilleHealth() {
  const status = await camille_status();
  
  if (!status.running) {
    throw new Error('Camille server not running');
  }
  
  if (!status.indexReady) {
    console.warn('Index not ready, search results may be incomplete');
  }
  
  if (status.queueSize > 50) {
    console.warn('Heavy indexing load detected');
  }
  
  return status;
}

## Pro Tips
- Server typically indexes 50-100 files per minute
- First-time indexing creates cache for faster restarts
- High queue sizes are normal after large commits
- indexReady=true means searches are reliable
- Monitor status during long-running operations`,
    inputSchema: {
      type: 'object',
      properties: {
        responseFormat: {
          type: 'string',
          enum: ['json', 'text', 'both'],
          description: 'Format for the response: json (raw data), text (formatted summary), both (default)',
          default: 'both'
        }
      }
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
        case 'search_code':
          return await this.handleSearchCode(args);
        case 'validate_code':
          return await this.handleValidateChanges(args);
        case 'server_status':
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
      const llmClient = new LLMClient(config, process.cwd());
      
      const queryEmbedding = await llmClient.generateEmbedding(query);
      
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

    // Require absolute paths
    if (!path.isAbsolute(filePath)) {
      return {
        error: 'Absolute file path required. Please provide the full absolute path to the file.',
        needsChanges: true,
        approved: false
      };
    }

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
    // When --mcp flag is used, run in stdio mode for Claude Code
    logger.info('Starting MCP server in stdio mode');
    
    // Set up stdio transport
    const transport = {
      async readMessage(): Promise<any> {
        return new Promise((resolve, reject) => {
          let buffer = '';
          
          const onData = (chunk: Buffer) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            
            // Process complete lines
            while (lines.length > 1) {
              const line = lines.shift()!;
              if (line.trim()) {
                try {
                  const message = JSON.parse(line);
                  process.stdin.off('data', onData);
                  resolve(message);
                  return;
                } catch (error) {
                  // Invalid JSON, continue reading
                }
              }
            }
            
            // Keep the last incomplete line in buffer
            buffer = lines[0];
          };
          
          process.stdin.on('data', onData);
        });
      },
      
      async writeMessage(message: any): Promise<void> {
        process.stdout.write(JSON.stringify(message) + '\n');
      }
    };
    
    // Handle messages in a loop
    while (true) {
      try {
        const message = await transport.readMessage();
        const response = await this.server.handleRequest(message);
        await transport.writeMessage(response);
      } catch (error) {
        if (error instanceof Error && error.message.includes('EOF')) {
          // Normal termination
          break;
        }
        logger.error('MCP error', error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        await transport.writeMessage({ error: errorMessage });
      }
    }
  }

  /**
   * Stops the MCP server
   */
  public async stop(): Promise<void> {
    // In stdio mode, there's nothing to clean up
    logger.info('MCP server stopped');
  }

  /**
   * Gets the pipe path for client configuration (deprecated)
   */
  public getPipePath(): string {
    return this.pipePath;
  }
  
  /**
   * Runs the MCP server as a standalone stdio process
   */
  public static async runStandalone(): Promise<void> {
    const server = new CamilleMCPServer();
    await server.start();
  }
}