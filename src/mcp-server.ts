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
import { UnifiedSearch } from './memory/search/unified-search';
import { LanceVectorDB } from './memory/databases/lance-db';
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
    description: `Search for code files in the repository using semantic similarity (vector search).

## Overview
This tool uses OpenAI embeddings to find files that are semantically similar to your query.
It searches through the entire indexed codebase using vector embeddings and returns the most 
relevant files based on conceptual similarity, not just keyword matching.

Note: For graph-based searches of code relationships (dependencies, calls, inheritance), 
use the 'graph_query' tool with Cypher queries instead.

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
      "preview": "export async function login(email: string, password: string) {\\n  const user = await User.findOne({ email });\\n  if (!user || !await bcrypt.compare(password, user.passwordHash)) {\\n    throw new AuthenticationError('Invalid credentials');\\n  }...",
      "lineMatches": [
        {
          "location": "src/auth/login.ts:42",
          "lineNumber": 42,
          "line": "export async function login(email: string, password: string) {",
          "snippet": "   39: import { AuthenticationError } from './errors';\\n   40: \\n   41: // Main login function\\n>  42: export async function login(email: string, password: string) {\\n   43:   const user = await User.findOne({ email });\\n   44:   if (!user || !await bcrypt.compare(password, user.passwordHash)) {"
        },
        {
          "location": "src/auth/login.ts:89",
          "lineNumber": 89,
          "line": "const token = jwt.sign({ userId: user.id }, secret);",
          "snippet": "   86:   // Generate JWT token\\n   87:   const secret = process.env.JWT_SECRET;\\n   88:   \\n>  89:   const token = jwt.sign({ userId: user.id }, secret);\\n   90:   \\n   91:   return { token, user };"
        }
      ]
    },
    {
      "path": "src/middleware/auth.ts",
      "similarity": "0.782",
      "summary": "Express middleware for JWT token validation, role-based access control, and API authentication. Handles token refresh and revocation.",
      "preview": "export const requireAuth = async (req, res, next) => {\\n  const token = req.headers.authorization?.split(' ')[1];\\n  if (!token) return res.status(401).json({ error: 'No token provided' });...",
      "lineMatches": [
        {
          "location": "src/middleware/auth.ts:15",
          "lineNumber": 15,
          "line": "export const requireAuth = async (req, res, next) => {",
          "snippet": "   12: import { verifyToken } from '../utils/jwt';\\n   13: \\n   14: // Main authentication middleware\\n>  15: export const requireAuth = async (req, res, next) => {\\n   16:   const token = req.headers.authorization?.split(' ')[1];\\n   17:   if (!token) return res.status(401).json({ error: 'No token provided' });"
        }
      ]
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
        includeDependencies: {
          type: 'boolean',
          description: 'Include dependency information (imports, calls, inheritance) in results',
          default: true
        },
        directory: {
          type: 'string',
          description: 'Limit results to files within this directory path (supports partial matching, e.g., "src/memory" matches all files in that path)'
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
      properties: {}
    }
  },

  /**
   * Recall previous discussions from conversation memory
   */
  recallMemory: {
    name: 'recall_previous_discussions',
    description: `🧠 ESSENTIAL TOOL: Search through our entire conversation history across all projects.
This tool helps maintain continuity across sessions and prevents repeating work.
YOU SHOULD USE THIS TOOL FREQUENTLY to understand context and past decisions.

## Overview
This tool searches through indexed conversation transcripts to find relevant discussions
from our past interactions. It uses semantic search to find conceptually similar conversations,
not just keyword matches.

## When to Use This Tool (USE PROACTIVELY!)
1. **ALWAYS when starting a new task** - Search for related work first
2. **When the user references past work** - "we discussed", "remember when", "last time"
3. **Before implementing features** - Check if similar work exists
4. **When debugging** - Search for similar errors or issues
5. **For context on any module** - Understand past decisions and implementations
6. **When user asks about progress** - Find what was previously done

⚠️ IMPORTANT: Use this tool BEFORE making assumptions about the codebase!

## Search Capabilities
- **Semantic understanding** - Finds conceptually related discussions
- **Time filtering** - Search within specific time ranges
- **Project filtering** - Limit to specific projects
- **Context preservation** - Shows surrounding conversation for clarity

## Example Queries
1. "authentication error we fixed last week"
2. "database migration approach we discussed"
3. "TypeScript configuration issues"
4. "deployment strategy for production"
5. "performance optimization techniques we tried"

## Response Format
Results include:
- Relevant conversation excerpts
- Session and project context
- Timestamps for reference
- Topics discussed
- Relevance scores
- Chunk IDs for full retrieval

Pro tip: The more specific your query, the better the results. Include project names,
error messages, or specific technical terms when possible. Use retrieve_memory_chunk to get full context.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'What you want to remember or find from our past conversations'
        },
        project_filter: {
          type: 'string',
          description: 'Optional: limit search to a specific project path'
        },
        time_range: {
          type: 'string',
          enum: ['today', 'week', 'month', 'all'],
          description: 'Optional: limit search to a specific time period',
          default: 'all'
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return',
          default: 10
        }
      },
      required: ['query']
    }
  },

  /**
   * Retrieve full memory chunk by ID
   */
  retrieveChunk: {
    name: 'retrieve_memory_chunk',
    description: `Retrieve the full content of a memory chunk by its ID.

## Overview
This tool fetches the complete conversation chunk that was found during a memory search.
Use this when you need to see the full context of a conversation, not just the excerpt.

## When to Use This Tool
1. **After searching** - When recall_previous_discussions returns a chunk ID
2. **Deep context** - When you need to understand the full conversation flow
3. **Code review** - To see all the code and discussions in a chunk
4. **Problem solving** - To understand how a complex issue was resolved

## Response Format
Returns the complete chunk with:
- Full conversation text
- All messages in the chunk
- Complete metadata
- Navigation to adjacent chunks
- Timestamp range covered

## Example Usage
After searching and finding chunk "session123-chunk-5", retrieve it:
retrieve_memory_chunk(chunk_id: "session123-chunk-5")`,
    inputSchema: {
      type: 'object',
      properties: {
        chunk_id: {
          type: 'string',
          description: 'The ID of the chunk to retrieve (from search results)'
        },
        include_adjacent: {
          type: 'boolean',
          description: 'Include summaries of previous and next chunks',
          default: false
        }
      },
      required: ['chunk_id']
    }
  },

  /**
   * Execute Cypher queries on the code graph database
   */
  graphQuery: {
    name: 'graph_query',
    description: `Execute Cypher queries on the code graph database to find relationships and patterns.

## Overview
This tool allows you to query the code structure graph using Cypher query language.
The graph contains nodes representing code objects (functions, classes, modules) and 
edges representing relationships (calls, imports, extends, implements).

## When to Use This Tool
1. **Finding dependencies** - What functions call a specific function?
2. **Understanding inheritance** - What classes extend a base class?
3. **Import analysis** - What modules import a specific module?
4. **Call graphs** - Trace function calls through the codebase
5. **Architecture analysis** - Find patterns in code structure

## Node Schema (CodeObject)
- id: Unique identifier (string)
- name: Function/class/module name (string)
- type: Code object type (string) - 'function' | 'class' | 'module' | 'interface' | 'method' | 'property'
- file: File path (string)
- line: Line number where defined (integer)
- col: Column number (integer)
- metadata: JSON string with additional properties (params, returns, visibility, etc.)
- name_embedding: Vector embedding of the name (array of floats, optional)
- summary_embedding: Vector embedding of the summary (array of floats, optional)

## Relationship Types
- CALLS: Function/method calls another function/method
- IMPORTS: Module imports another module
- EXTENDS: Class extends another class
- IMPLEMENTS: Class implements an interface
- USES: General usage relationship
- HAS_METHOD: Class has a method
- HAS_PROPERTY: Class has a property
- RETURNS: Function returns a type
- ACCEPTS: Function accepts a parameter type

## Example Queries

### Find functions that call a specific function
\`\`\`cypher
MATCH (n:CodeObject)-[:CALLS]->(m:CodeObject {name: 'validateUser'})
WHERE n.type = 'function'
RETURN n.name, n.file, n.line
LIMIT 10
\`\`\`

### Find all classes that extend a base class
\`\`\`cypher
MATCH (n:CodeObject {type: 'class'})-[:EXTENDS]->(m:CodeObject {name: 'BaseController'})
RETURN n.name, n.file
\`\`\`

### Find import dependencies of a module
\`\`\`cypher
MATCH (n:CodeObject {file: 'src/auth/login.ts'})-[:IMPORTS]->(m:CodeObject)
RETURN m.name, m.file
\`\`\`

### Find all functions in a specific file
\`\`\`cypher
MATCH (n:CodeObject {type: 'function'})
WHERE n.file =~ '.*server\\.ts$'
RETURN n.name, n.line
ORDER BY n.line
\`\`\`

### Find circular dependencies
\`\`\`cypher
MATCH (a:CodeObject)-[:IMPORTS]->(b:CodeObject)-[:IMPORTS]->(a)
RETURN a.file, b.file
LIMIT 5
\`\`\`

## Pro Tips
- Use LIMIT to control result size
- Use WHERE clauses to filter results
- Property names are case-sensitive
- Use =~ for regex pattern matching
- Escape single quotes in strings by doubling them`,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The Cypher query to execute'
        },
        explain: {
          type: 'boolean',
          description: 'If true, explain the query plan without executing',
          default: false
        }
      },
      required: ['query']
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
    logger.info('MCP Server initializing with tools', {
      toolCount: Object.keys(TOOLS).length,
      toolNames: Object.values(TOOLS).map((t: any) => t.name),
      toolKeys: Object.keys(TOOLS)
    });
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
    logger.info('setupHandlers called');
    
    // List available tools
    this.server.setRequestHandler('tools/list', async () => {
      logger.info('tools/list handler START');
      
      // Debug TOOLS at runtime
      logger.info('TOOLS object debug', {
        type: typeof TOOLS,
        keys: Object.keys(TOOLS),
        keysLength: Object.keys(TOOLS).length
      });

      console.log('TOOLS object debug', {
        type: typeof TOOLS,
        keys: Object.keys(TOOLS),
        keysLength: Object.keys(TOOLS).length
      });
      
      const tools = Object.values(TOOLS);
      logger.info('After Object.values()', {
        toolsLength: tools.length,
        toolsIsArray: Array.isArray(tools),
        firstToolName: tools[0]?.name,
        lastToolName: tools[tools.length - 1]?.name
      });
      
      // Log each tool
      tools.forEach((tool: any, index: number) => {
        logger.info(`Tool ${index}`, {
          name: tool.name,
          hasDescription: !!tool.description,
          descLength: tool.description?.length
        });
      });
      
      const response = {
        tools: tools
      };
      
      logger.info('tools/list handler END', { 
        returning: tools.length,
        responseKeys: Object.keys(response),
        responseToolsLength: response.tools.length
      });
      
      return response;
    });

    // Note: Tool calls are handled directly by the protocol server via registerTool() in server.ts
    // No need for a switch statement handler here
  }

  // handleSearchCode removed - now handled directly in server.ts via tool registration

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

      const approved = result.decision === 'approve';
      const details = this.parseValidationDetails(result.reason || '');

      // Generate text summary
      let textSummary = approved ? '✅ Code approved\n\n' : '❌ Code requires changes\n\n';
      
      if (result.reason) {
        textSummary += `${result.reason}\n\n`;
      }

      if (details) {
        if (details.securityIssues?.length > 0) {
          textSummary += `Security Issues:\n${details.securityIssues.map((i: string) => `- ${i}`).join('\n')}\n\n`;
        }
        if (details.complianceIssues?.length > 0) {
          textSummary += `Compliance Issues:\n${details.complianceIssues.map((i: string) => `- ${i}`).join('\n')}\n\n`;
        }
        if (details.qualityIssues?.length > 0) {
          textSummary += `Quality Issues:\n${details.qualityIssues.map((i: string) => `- ${i}`).join('\n')}\n\n`;
        }
      }

      return {
        content: [{
          type: 'text',
          text: textSummary.trim()
        }],
        approved,
        reason: result.reason,
        needsChanges: result.decision === 'block',
        details,
        summary: textSummary.trim()
      };

    } catch (error) {
      const errorMessage = `Validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
      return {
        content: [{
          type: 'text',
          text: errorMessage
        }],
        error: errorMessage
      };
    }
  }

  /**
   * Handles status requests
   */
  private async handleGetStatus(args: any = {}): Promise<any> {
    const server = ServerManager.getInstance();
    
    if (!server) {
      const notRunningMessage = 'Camille server is not running';
      return {
        content: [{
          type: 'text',
          text: notRunningMessage
        }],
        running: false,
        message: notRunningMessage
      };
    }

    const status = server.getStatus();
    const running = status.isRunning;
    const indexReady = server.getEmbeddingsIndex().isIndexReady();
    const indexing = status.isIndexing;
    const filesIndexed = status.indexSize;
    const queueSize = status.queueSize;

    // Generate text summary
    let textSummary = `Camille Server Status:\n`;
    textSummary += `- Running: ${running ? 'Yes' : 'No'}\n`;
    textSummary += `- Index Ready: ${indexReady ? 'Yes' : 'No'}\n`;
    textSummary += `- Currently Indexing: ${indexing ? 'Yes' : 'No'}\n`;
    textSummary += `- Files Indexed: ${filesIndexed}\n`;
    textSummary += `- Queue Size: ${queueSize}`;

    return {
      content: [{
        type: 'text',
        text: textSummary
      }],
      running,
      indexReady,
      indexing,
      filesIndexed,
      queueSize,
      summary: textSummary
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
   * Handles memory recall requests
   */
  public async handleRecallMemory(args: any): Promise<any> {
    const { query, project_filter, time_range = 'all', limit = 10 } = args;

    try {
      // Check if memory is enabled
      const config = new ConfigManager();
      if (!config.getConfig().memory?.enabled) {
        const errorMessage = 'Memory system is not enabled. Run "camille setup" to enable it.';
        return {
          content: [{
            type: 'text',
            text: errorMessage
          }],
          error: errorMessage,
          hint: 'The memory system needs to be configured to store and search conversation history.'
        };
      }

      // Create unified search instance
      const search = new UnifiedSearch();

      // Perform search
      const results = await search.search(query, {
        limit,
        projectFilter: project_filter,
        timeRange: time_range as any,
        includeGraph: false, // Only search conversations for now
        scoreThreshold: 0.5
      });

      if (results.conversations.length === 0) {
        const noResultsMessage = `No relevant conversations found for query: "${query}"\n\nFilters applied:\n- Project: ${project_filter || 'All projects'}\n- Time range: ${time_range}\n\nTry broader search terms or different time ranges.`;
        return {
          content: [{
            type: 'text',
            text: noResultsMessage
          }],
          message: 'No relevant conversations found',
          query,
          filters: { project_filter, time_range },
          hint: 'Try broader search terms or different time ranges'
        };
      }

      // Format results for Claude
      let textSummary = `Found ${results.conversations.length} relevant conversation${results.conversations.length > 1 ? 's' : ''}:\n\n`;
      textSummary += `💡 To see the full context of any result, use: retrieve_memory_chunk(chunk_id: "...")\n\n`;
      
      for (let i = 0; i < results.conversations.length; i++) {
        const conversation = results.conversations[i];
        textSummary += `### Result ${i + 1}\n`;
        textSummary += `📅 ${new Date(conversation.timestamp).toLocaleString()}\n`;
        textSummary += `📁 Project: ${conversation.projectPath || 'Unknown'}\n`;
        textSummary += `🏷️ Topics: ${conversation.topics?.join(', ') || 'General'}\n`;
        textSummary += `📊 Relevance: ${(conversation.score * 100).toFixed(1)}%\n`;
        textSummary += `🔑 Chunk ID: ${conversation.chunkId || 'Not available'}\n\n`;
        textSummary += `💬 Context:\n${conversation.context}\n`;
        
        if (conversation.chunkId) {
          textSummary += `\n📖 To see full conversation: retrieve_memory_chunk(chunk_id: "${conversation.chunkId}")\n`;
        }
        
        textSummary += `\n${'─'.repeat(60)}\n\n`;
      }

      return {
        content: [{
          type: 'text',
          text: textSummary.trim()
        }],
        results: results.conversations,
        totalFound: results.conversations.length,
        searchTime: results.searchTime,
        summary: textSummary.trim()
      };

    } catch (error) {
      logger.error('Memory recall failed', { error });
      const errorMessage = `Memory recall failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
      return {
        content: [{
          type: 'text',
          text: errorMessage
        }],
        error: errorMessage,
        hint: 'Make sure the memory system is properly configured and the vector database is accessible.'
      };
    }
  }

  /**
   * Handles memory chunk retrieval requests
   */
  public async handleRetrieveChunk(args: any): Promise<any> {
    const { chunk_id, include_adjacent = false } = args;

    try {
      // Check if memory is enabled
      const config = new ConfigManager();
      if (!config.getConfig().memory?.enabled) {
        const errorMessage = 'Memory system is not enabled. Run "camille setup" to enable it.';
        return {
          content: [{
            type: 'text',
            text: errorMessage
          }],
          error: errorMessage
        };
      }

      // Create vector database instance to retrieve by chunk ID
      const vectorDB = new LanceVectorDB('transcripts');
      await vectorDB.connect();

      try {
        // Retrieve the specific chunk by ID
        const chunk = await vectorDB.retrieveByChunkId(chunk_id);

        if (!chunk) {
          const notFoundMessage = `Chunk not found: ${chunk_id}\n\nMake sure you're using a valid chunk ID from search results.`;
          return {
            content: [{
              type: 'text',
              text: notFoundMessage
            }],
            error: 'Chunk not found'
          };
        }
        
        // Format the full chunk content
        let textSummary = `## Memory Chunk: ${chunk_id}\n\n`;
        textSummary += `📅 Time Range: ${new Date(chunk.metadata.startTime).toLocaleString()} - ${new Date(chunk.metadata.endTime).toLocaleString()}\n`;
        textSummary += `📁 Project: ${chunk.metadata.projectPath || 'Unknown'}\n`;
        textSummary += `🏷️ Topics: ${chunk.metadata.topics?.join(', ') || 'General'}\n`;
        textSummary += `📊 Messages: ${chunk.metadata.messageCount || 'Unknown'}\n\n`;
        textSummary += `### Full Conversation:\n\n`;
        textSummary += chunk.content || 'No content available';
        
        if (include_adjacent && chunk.metadata.chunkIndex !== undefined) {
          textSummary += `\n\n### Navigation:\n`;
          if (chunk.metadata.chunkIndex > 0) {
            textSummary += `⬅️ Previous: ${chunk.metadata.sessionId}-chunk-${chunk.metadata.chunkIndex - 1}\n`;
          }
          textSummary += `⏺️ Current: ${chunk_id} (chunk ${chunk.metadata.chunkIndex})\n`;
          textSummary += `➡️ Next: ${chunk.metadata.sessionId}-chunk-${chunk.metadata.chunkIndex + 1}\n`;
        }

        return {
          content: [{
            type: 'text',
            text: textSummary
          }],
          chunkId: chunk_id,
          metadata: chunk.metadata
        };

      } finally {
        await vectorDB.close();
      }

    } catch (error) {
      logger.error('Chunk retrieval failed', { error, chunk_id });
      const errorMessage = `Failed to retrieve chunk: ${error instanceof Error ? error.message : 'Unknown error'}`;
      return {
        content: [{
          type: 'text',
          text: errorMessage
        }],
        error: errorMessage
      };
    }
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