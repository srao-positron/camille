/**
 * Server mode implementation for Camille
 * Runs as a background service with file watching and embedding indexing
 */

import * as chokidar from 'chokidar';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as net from 'net';
import { glob } from 'glob';
import PQueue from 'p-queue';
import ora from 'ora';
import chalk from 'chalk';
import { ConfigManager } from './config';
import { LLMClient } from './llm-client';
import { OpenAIClient } from './openai-client';
import { EmbeddingsIndex, FileFilter, SearchResult } from './embeddings';
import { EMBEDDING_PROMPT } from './prompts';
import { consoleOutput, isQuietMode } from './utils/console';
import { logger } from './logger';

/**
 * Server status
 */
export interface ServerStatus {
  isRunning: boolean;
  isIndexing: boolean;
  indexSize: number;
  queueSize: number;
  watchedDirectories: string[];
}

/**
 * Camille server class
 */
export class CamilleServer {
  private configManager: ConfigManager;
  private llmClient: LLMClient;
  private openaiClient: OpenAIClient;
  private embeddingsIndex: EmbeddingsIndex;
  private fileFilter: FileFilter;
  private watchers: Map<string, chokidar.FSWatcher>;
  private watchedDirectories: Set<string>;
  private indexQueue: PQueue;
  private status: ServerStatus;
  private spinner?: any;
  private configWatcher?: chokidar.FSWatcher;
  private lastConfigContent?: string;
  private pipeServer?: any;
  private pipePath: string;

  constructor() {
    this.configManager = new ConfigManager();
    const config = this.configManager.getConfig();
    
    this.llmClient = new LLMClient(config, process.cwd());
    // Always use OpenAI API key for embeddings, regardless of provider
    const openaiApiKey = this.configManager.getOpenAIApiKey();
    this.openaiClient = new OpenAIClient(openaiApiKey, config, process.cwd());
    this.embeddingsIndex = new EmbeddingsIndex(this.configManager);
    this.fileFilter = new FileFilter(config.ignorePatterns);
    
    // Initialize collections
    this.watchers = new Map();
    this.watchedDirectories = new Set();
    
    // Queue for processing files with concurrency limit
    this.indexQueue = new PQueue({ concurrency: 3 });
    
    this.status = {
      isRunning: false,
      isIndexing: false,
      indexSize: 0,
      queueSize: 0,
      watchedDirectories: []
    };
    
    // Set up named pipe path in ~/.camille directory for consistency
    const pipeDir = process.env.CAMILLE_CONFIG_DIR || path.join(os.homedir(), '.camille');
    this.pipePath = process.platform === 'win32' 
      ? '\\\\.\\pipe\\camille-mcp'
      : path.join(pipeDir, 'camille-mcp.sock');
  }

  /**
   * Starts the server with one or more directories
   */
  public async start(directories: string | string[] = process.cwd()): Promise<void> {
    consoleOutput.info(chalk.blue('🚀 Starting Camille server...'));
    logger.logServerEvent('server_starting', { directories });
    
    this.status.isRunning = true;
    
    // Start the named pipe server IMMEDIATELY for MCP communication
    await this.startPipeServer();
    consoleOutput.info(chalk.green('✅ MCP server ready - accepting connections'));
    
    // Normalize to array
    const dirsToWatch = Array.isArray(directories) ? directories : [directories];
    
    // If no directories to watch, mark index as ready
    if (dirsToWatch.length === 0) {
      this.embeddingsIndex.setReady(true);
      consoleOutput.info(chalk.gray('No directories to index'));
    } else {
      // Start indexing directories in the background
      consoleOutput.info(chalk.gray('Starting background indexing...'));
      this.startBackgroundIndexing(dirsToWatch);
    }
    
    logger.logServerEvent('server_started', { 
      directories: this.getWatchedDirectories(),
      pipeReady: true,
      indexing: dirsToWatch.length > 0
    });
    
    // Set up config file watching
    this.setupConfigWatcher();
  }

  /**
   * Starts indexing directories in the background
   */
  private async startBackgroundIndexing(directories: string[]): Promise<void> {
    // Don't await - let it run in background
    (async () => {
      try {
        for (const dir of directories) {
          await this.addDirectory(dir);
        }
        
        // Wait for index to be ready
        while (!this.embeddingsIndex.isIndexReady()) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        consoleOutput.success('✅ Indexing complete');
        consoleOutput.info(chalk.gray(`Indexed files: ${this.embeddingsIndex.getIndexSize()}`));
        
        logger.logServerEvent('indexing_completed', { 
          directories: this.getWatchedDirectories(),
          indexSize: this.embeddingsIndex.getIndexSize() 
        });
      } catch (error) {
        logger.error('Background indexing failed', error as Error);
        consoleOutput.error(`Background indexing failed: ${error}`);
      }
    })();
  }

  /**
   * Adds a directory to watch
   */
  public async addDirectory(directory: string): Promise<void> {
    const absPath = path.resolve(directory);
    
    // Check if already watching
    if (this.watchedDirectories.has(absPath)) {
      consoleOutput.warning(`Already watching: ${absPath}`);
      return;
    }
    
    // Verify directory exists
    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isDirectory()) {
      throw new Error(`Not a valid directory: ${absPath}`);
    }
    
    consoleOutput.info(chalk.blue(`Adding directory: ${absPath}`));
    
    // Add to watched set
    this.watchedDirectories.add(absPath);
    this.status.watchedDirectories = Array.from(this.watchedDirectories);
    
    // Index the directory
    await this.performInitialIndexing(absPath);
    
    // Set up file watcher
    this.setupFileWatcher(absPath);
    
    consoleOutput.success(`✅ Now watching: ${absPath}`);
    logger.logServerEvent('directory_added', { directory: absPath });
  }
  
  /**
   * Removes a directory from watching
   */
  public async removeDirectory(directory: string): Promise<void> {
    const absPath = path.resolve(directory);
    
    if (!this.watchedDirectories.has(absPath)) {
      consoleOutput.warning(`Not watching: ${absPath}`);
      return;
    }
    
    consoleOutput.info(chalk.blue(`Removing directory: ${absPath}`));
    
    // Close the watcher
    const watcher = this.watchers.get(absPath);
    if (watcher) {
      await watcher.close();
      this.watchers.delete(absPath);
    }
    
    // Remove from watched set
    this.watchedDirectories.delete(absPath);
    this.status.watchedDirectories = Array.from(this.watchedDirectories);
    
    // Remove files from index
    const indexedFiles = this.embeddingsIndex.getIndexedFiles();
    for (const file of indexedFiles) {
      if (file.startsWith(absPath)) {
        this.embeddingsIndex.removeFile(file);
      }
    }
    
    consoleOutput.success(`✅ Stopped watching: ${absPath}`);
    logger.logServerEvent('directory_removed', { directory: absPath });
  }
  
  /**
   * Gets list of watched directories
   */
  public getWatchedDirectories(): string[] {
    return Array.from(this.watchedDirectories);
  }
  
  /**
   * Stops the server
   */
  public async stop(): Promise<void> {
    consoleOutput.warning('Stopping Camille server...');
    logger.logServerEvent('server_stopping');
    
    this.status.isRunning = false;
    
    // Close all watchers
    for (const [_, watcher] of this.watchers) {
      await watcher.close();
    }
    this.watchers.clear();
    this.watchedDirectories.clear();
    
    // Close config watcher
    if (this.configWatcher) {
      await this.configWatcher.close();
      this.configWatcher = undefined;
    }
    
    // Close pipe server
    if (this.pipeServer) {
      this.pipeServer.close();
      this.pipeServer = undefined;
      
      // Remove the pipe file
      if (fs.existsSync(this.pipePath)) {
        fs.unlinkSync(this.pipePath);
      }
    }
    
    await this.indexQueue.onIdle();
    
    consoleOutput.success('✅ Camille server stopped');
    logger.logServerEvent('server_stopped');
  }

  /**
   * Gets the current server status
   */
  public getStatus(): ServerStatus {
    return {
      ...this.status,
      indexSize: this.embeddingsIndex.getIndexSize(),
      queueSize: this.indexQueue.size,
      watchedDirectories: Array.from(this.watchedDirectories)
    };
  }

  /**
   * Gets the embeddings index
   */
  public getEmbeddingsIndex(): EmbeddingsIndex {
    return this.embeddingsIndex;
  }

  /**
   * Starts the named pipe server for MCP communication
   */
  private async startPipeServer(): Promise<void> {
    // Remove existing pipe if it exists
    if (fs.existsSync(this.pipePath)) {
      fs.unlinkSync(this.pipePath);
    }

    // Create the named pipe server
    this.pipeServer = net.createServer((socket) => {
      const clientId = Date.now();
      logger.info('MCP client connected via named pipe', { clientId, pipePath: this.pipePath });
      
      // Also log to dedicated MCP file
      fs.appendFileSync('/tmp/camille-mcp-server.log', 
        `[${new Date().toISOString()}] CLIENT CONNECTED: ${clientId}\n`);
      
      let buffer = '';
      let requestCount = 0;
      
      socket.on('data', async (data) => {
        const dataStr = data.toString();
        buffer += dataStr;
        
        // Log raw data received
        fs.appendFileSync('/tmp/camille-mcp-server.log', 
          `[${new Date().toISOString()}] [${clientId}] RAW DATA (${data.length} bytes): ${dataStr.substring(0, 200)}...\n`);
        
        const lines = buffer.split('\n');
        
        // Process complete lines
        while (lines.length > 1) {
          const line = lines.shift()!;
          if (line.trim()) {
            requestCount++;
            const requestId = `${clientId}-${requestCount}`;
            
            fs.appendFileSync('/tmp/camille-mcp-server.log', 
              `[${new Date().toISOString()}] [${requestId}] PROCESSING LINE: ${line}\n`);
            
            try {
              const request = JSON.parse(line);
              
              fs.appendFileSync('/tmp/camille-mcp-server.log', 
                `[${new Date().toISOString()}] [${requestId}] PARSED REQUEST: ${JSON.stringify(request)}\n`);
              
              logger.info('MCP request received', { requestId, method: request.method, id: request.id });
              
              const response = await this.handleMCPRequest(request);
              
              // Handle null responses (for notifications)
              if (response === null) {
                fs.appendFileSync('/tmp/camille-mcp-server.log', 
                  `[${new Date().toISOString()}] [${requestId}] NO RESPONSE (notification)\n`);
                continue;
              }
              
              fs.appendFileSync('/tmp/camille-mcp-server.log', 
                `[${new Date().toISOString()}] [${requestId}] SENDING RESPONSE: ${JSON.stringify(response)}\n`);
              
              logger.info('MCP response sent', { requestId, hasResult: !!response?.result, hasError: !!response?.error });
              
              socket.write(JSON.stringify(response) + '\n');
            } catch (error) {
              logger.error('Error handling MCP request', { requestId, error });
              
              fs.appendFileSync('/tmp/camille-mcp-server.log', 
                `[${new Date().toISOString()}] [${requestId}] ERROR: ${error}\n${error instanceof Error ? error.stack : ''}\n`);
              
              const errorResponse = {
                jsonrpc: '2.0',
                error: {
                  code: -32603,
                  message: error instanceof Error ? error.message : 'Unknown error'
                },
                id: null
              };
              socket.write(JSON.stringify(errorResponse) + '\n');
            }
          }
        }
        
        // Keep the last incomplete line in buffer
        buffer = lines[0];
      });
      
      socket.on('error', (error: Error) => {
        logger.error('Named pipe socket error', { clientId, error });
        fs.appendFileSync('/tmp/camille-mcp-server.log', 
          `[${new Date().toISOString()}] [${clientId}] SOCKET ERROR: ${error}\n`);
      });
      
      socket.on('close', () => {
        logger.info('MCP client disconnected', { clientId });
        fs.appendFileSync('/tmp/camille-mcp-server.log', 
          `[${new Date().toISOString()}] [${clientId}] CLIENT DISCONNECTED\n\n`);
      });
    });

    // Listen on the named pipe
    this.pipeServer.listen(this.pipePath, () => {
      consoleOutput.info(chalk.gray(`MCP pipe server listening on: ${this.pipePath}`));
      logger.info('Named pipe server started', { pipePath: this.pipePath });
    });

    this.pipeServer.on('error', (error: Error) => {
      logger.error('Named pipe server error', error);
      consoleOutput.error(`Failed to start pipe server: ${error}`);
    });
  }

  /**
   * Handles MCP requests received via named pipe
   */
  private async handleMCPRequest(request: any): Promise<any> {
    const startTime = Date.now();
    logger.debug('Handling MCP request', { method: request.method, id: request.id });
    
    fs.appendFileSync('/tmp/camille-mcp-server.log', 
      `[${new Date().toISOString()}] HANDLE MCP REQUEST: ${request.method} (id: ${request.id})\n`);
    
    // Use the MCP protocol server to handle all protocol messages
    if (!this.mcpProtocolServer) {
      fs.appendFileSync('/tmp/camille-mcp-server.log', 
        `[${new Date().toISOString()}] INITIALIZING MCP PROTOCOL SERVER\n`);
      const { MCPProtocolServer } = require('./mcp-protocol');
      const { TOOLS } = require('./mcp-server');
      
      // Create MCP protocol server
      this.mcpProtocolServer = new MCPProtocolServer(
        { name: 'camille', version: '0.1.0' },
        { tools: { listChanged: true } }
      );
      
      // Register tools
      this.mcpProtocolServer.registerTool(TOOLS.searchCode, async (args: any) => {
        const result = await this.handleSearchCode(args);
        return result && result.result ? result.result : result;
      });
      
      this.mcpProtocolServer.registerTool(TOOLS.validateChanges, async (args: any) => {
        const { CamilleHook } = require('./hook');
        const hook = new CamilleHook();
        const result = await this.handleValidateChanges(args, hook);
        return result && result.result ? result.result : result;
      });
      
      this.mcpProtocolServer.registerTool(TOOLS.getStatus, async (args: any) => {
        const result = await this.handleGetStatus(args);
        return result;
      });
      
      this.mcpProtocolServer.registerTool(TOOLS.recallMemory, async (args: any) => {
        const { CamilleMCPServer } = require('./mcp-server');
        const mcpServer = new CamilleMCPServer();
        const result = await mcpServer.handleRecallMemory(args);
        return result;
      });
      
      this.mcpProtocolServer.registerTool(TOOLS.retrieveChunk, async (args: any) => {
        const { CamilleMCPServer } = require('./mcp-server');
        const mcpServer = new CamilleMCPServer();
        const result = await mcpServer.handleRetrieveChunk(args);
        return result;
      });
    }
    
    // Handle message through protocol server
    try {
      fs.appendFileSync('/tmp/camille-mcp-server.log', 
        `[${new Date().toISOString()}] CALLING handleMessage for: ${request.method}\n`);
      
      const response = await this.mcpProtocolServer.handleMessage(request);
      const duration = Date.now() - startTime;
      
      fs.appendFileSync('/tmp/camille-mcp-server.log', 
        `[${new Date().toISOString()}] HANDLE MCP COMPLETE: ${request.method} took ${duration}ms, response: ${JSON.stringify(response)}\n`);
      
      logger.debug('MCP request handled', { method: request.method, duration, hasResult: response ? !!response.result : false });
      
      return response;
    } catch (error) {
      const duration = Date.now() - startTime;
      
      fs.appendFileSync('/tmp/camille-mcp-server.log', 
        `[${new Date().toISOString()}] HANDLE MCP ERROR: ${request.method} failed after ${duration}ms: ${error}\n`);
      
      throw error;
    }
  }
  
  private mcpProtocolServer: any;

  /**
   * Handles code search requests
   */
  private async handleSearchCode(args: any): Promise<any> {
    const { query, limit = 10, responseFormat = 'both' } = args;
    
    try {
      const queryEmbedding = await this.openaiClient.generateEmbedding(query);
      const results = this.embeddingsIndex.search(queryEmbedding, limit);
      
      const jsonResult: any = {
        results: results.map((result: SearchResult) => ({
          path: path.relative(process.cwd(), result.path),
          similarity: result.similarity.toFixed(3),
          summary: result.summary || 'No summary available',
          preview: result.content.substring(0, 200) + '...'
        })),
        totalFiles: this.embeddingsIndex.getIndexSize(),
        indexStatus: {
          ready: this.embeddingsIndex.isIndexReady(),
          filesIndexed: this.embeddingsIndex.getIndexSize(),
          isIndexing: this.status.isIndexing
        }
      };
      
      // Add warning if still indexing
      if (!this.embeddingsIndex.isIndexReady()) {
        jsonResult.warning = 'Index is still building. Results may be incomplete.';
        logger.info('Search performed while indexing', { 
          query, 
          resultsFound: results.length,
          filesIndexedSoFar: this.embeddingsIndex.getIndexSize() 
        });
      }
      
      // Format response based on requested format
      if (responseFormat === 'json') {
        return jsonResult;
      } else if (responseFormat === 'text') {
        return this.formatSearchResultsAsText(query, jsonResult);
      } else {
        // 'both' format - MCP expects 'content' field for display
        return {
          content: [
            {
              type: 'text',
              text: this.formatSearchResultsAsText(query, jsonResult)
            }
          ],
          // Also include structured data for programmatic access
          data: jsonResult
        };
      }
    } catch (error) {
      throw error; // Let MCP protocol handle errors
    }
  }
  
  private formatSearchResultsAsText(query: string, results: any): string {
    let text = `Camille Code Search Results\n`;
    text += `Query: "${query}"\n`;
    text += `${'═'.repeat(50)}\n\n`;
    
    if (results.warning) {
      text += `WARNING: ${results.warning}\n\n`;
    }
    
    text += `Found ${results.results.length} relevant files (out of ${results.totalFiles} total)\n\n`;
    
    results.results.forEach((result: any, index: number) => {
      text += `${index + 1}. ${result.path} (similarity: ${result.similarity})\n`;
      text += `   Summary: ${result.summary}\n`;
      text += `   Preview: ${result.preview}\n\n`;
    });
    
    text += `\nIndex Status: ${results.indexStatus.ready ? 'Ready' : 'Indexing...'}`;
    text += ` (${results.indexStatus.filesIndexed} files indexed)`;
    
    return text;
  }

  /**
   * Handles validation requests
   */
  private async handleValidateChanges(args: any, hook: any): Promise<any> {
    const { filePath, changes, changeType, responseFormat = 'both' } = args;
    
    try {
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
      
      const jsonResult = {
        approved: result.decision === 'approve',
        reason: result.reason,
        needsChanges: result.decision === 'block',
        details: this.parseValidationDetails(result.reason || '')
      };

      // Format response based on requested format
      if (responseFormat === 'json') {
        return jsonResult;
      } else if (responseFormat === 'text') {
        return this.formatValidationResultAsText(filePath, changeType, jsonResult);
      } else {
        // 'both' format - MCP expects 'content' field for display
        return {
          content: [
            {
              type: 'text',
              text: this.formatValidationResultAsText(filePath, changeType, jsonResult)
            }
          ],
          // Also include structured data for programmatic access
          data: jsonResult
        };
      }
    } catch (error) {
      throw error; // Let MCP protocol handle errors
    }
  }
  
  private formatValidationResultAsText(filePath: string, changeType: string, result: any): string {
    let text = `Camille Security & Compliance Report\n`;
    text += `${'═'.repeat(50)}\n\n`;
    text += `File: ${filePath}\n`;
    text += `Change Type: ${changeType}\n`;
    text += `Status: ${result.approved ? 'APPROVED' : 'NEEDS CHANGES'}\n\n`;
    
    if (result.reason) {
      text += `Summary:\n${result.reason}\n\n`;
    }
    
    if (result.details) {
      if (result.details.securityIssues?.length > 0) {
        text += `Security Issues:\n`;
        result.details.securityIssues.forEach((issue: string) => {
          text += `  • ${issue}\n`;
        });
        text += '\n';
      }
      
      if (result.details.complianceIssues?.length > 0) {
        text += `Compliance Issues:\n`;
        result.details.complianceIssues.forEach((issue: string) => {
          text += `  • ${issue}\n`;
        });
        text += '\n';
      }
      
      if (result.details.qualityIssues?.length > 0) {
        text += `Code Quality Issues:\n`;
        result.details.qualityIssues.forEach((issue: string) => {
          text += `  • ${issue}\n`;
        });
        text += '\n';
      }
      
      if (result.details.suggestedFix) {
        text += `Suggested Fix:\n${result.details.suggestedFix}\n`;
      }
    }
    
    return text.trim();
  }
  
  /**
   * Handles status requests
   */
  private async handleGetStatus(args: any): Promise<any> {
    const { responseFormat = 'both' } = args;
    
    const jsonResult = {
      running: true,
      indexReady: this.embeddingsIndex.isIndexReady(),
      indexing: this.status.isIndexing,
      filesIndexed: this.embeddingsIndex.getIndexSize(),
      queueSize: this.indexQueue.size
    };
    
    // Format response based on requested format
    if (responseFormat === 'json') {
      return jsonResult;
    } else if (responseFormat === 'text') {
      return this.formatStatusAsText(jsonResult);
    } else {
      // 'both' format - MCP expects 'content' field for display
      return {
        content: [
          {
            type: 'text',
            text: this.formatStatusAsText(jsonResult)
          }
        ],
        // Also include structured data for programmatic access
        data: jsonResult
      };
    }
  }
  
  private formatStatusAsText(status: any): string {
    let text = `Camille Server Status\n`;
    text += `${'═'.repeat(50)}\n\n`;
    
    text += `Server: ${status.running ? 'Running' : 'Stopped'}\n`;
    text += `Index: ${status.indexReady ? 'Ready' : 'Building...'}\n`;
    text += `Status: ${status.indexing ? 'Indexing files...' : 'Idle'}\n\n`;
    
    text += `Files Indexed: ${status.filesIndexed}\n`;
    if (status.queueSize > 0) {
      text += `Queue: ${status.queueSize} files pending\n`;
    }
    
    if (!status.indexReady) {
      text += `\nNote: Search results may be incomplete until indexing finishes.\n`;
    }
    
    return text.trim();
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
   * Performs initial indexing of all files
   */
  private async performInitialIndexing(directory: string): Promise<void> {
    this.spinner = isQuietMode() ? null : ora('Discovering files...').start();
    this.status.isIndexing = true;
    logger.logServerEvent('indexing_started', { directory });
    
    try {
      // Find all files to index
      const files = await glob('**/*', {
        cwd: directory,
        nodir: true,
        absolute: true,
        ignore: this.configManager.getConfig().ignorePatterns
      });
      
      const filesToIndex = files.filter(file => this.fileFilter.shouldIndex(file));
      
      if (filesToIndex.length === 0) {
        if (this.spinner) this.spinner.succeed('No files to index');
        consoleOutput.info('No files to index');
        this.embeddingsIndex.setReady(true);
        return;
      }
      
      if (this.spinner) this.spinner.text = `Indexing ${filesToIndex.length} files...`;
      logger.info(`Starting to index ${filesToIndex.length} files`);
      
      // Add all files to the queue
      let processed = 0;
      let skipped = 0;
      for (const file of filesToIndex) {
        this.indexQueue.add(async () => {
          // Check if file needs indexing (use cache if available)
          if (this.embeddingsIndex.needsReindex(file)) {
            await this.indexFile(file);
          } else {
            skipped++;
            logger.debug('Using cached embedding', { path: file });
          }
          processed++;
          if (this.spinner) {
            const skipText = skipped > 0 ? ` (${skipped} cached)` : '';
            this.spinner.text = `Indexing files... (${processed}/${filesToIndex.length})${skipText}`;
          }
        });
      }
      
      // Wait for all indexing to complete
      await this.indexQueue.onIdle();
      
      const newlyIndexed = filesToIndex.length - skipped;
      const message = skipped > 0 
        ? `Indexed ${newlyIndexed} new files, used cache for ${skipped} files`
        : `Indexed ${filesToIndex.length} files`;
      
      if (this.spinner) this.spinner.succeed(message);
      consoleOutput.success(message);
      logger.logServerEvent('indexing_completed', { 
        directory, 
        totalFiles: filesToIndex.length,
        newlyIndexed,
        cachedFiles: skipped
      });
      this.embeddingsIndex.setReady(true);
      
    } catch (error) {
      if (this.spinner) this.spinner.fail(`Indexing failed: ${error}`);
      consoleOutput.error(`Indexing failed: ${error}`);
      logger.error('Indexing failed', error, { directory });
      throw error;
    } finally {
      this.status.isIndexing = false;
    }
  }

  /**
   * Sets up file watcher for changes
   */
  private setupFileWatcher(directory: string): void {
    const watcher = chokidar.watch(directory, {
      ignored: [
        /(^|[\/\\])\../, // dot files
        ...this.configManager.getConfig().ignorePatterns
      ],
      persistent: true,
      ignoreInitial: true
    });
    
    // Store watcher
    this.watchers.set(directory, watcher);
    
    // Handle file changes
    watcher.on('change', (filePath) => {
      if (this.fileFilter.shouldIndex(filePath)) {
        consoleOutput.debug(`File changed: ${path.relative(directory, filePath)}`);
        logger.info('File change detected', { path: filePath, directory });
        this.indexQueue.add(() => this.reindexFile(filePath));
      }
    });
    
    // Handle new files
    watcher.on('add', (filePath) => {
      if (this.fileFilter.shouldIndex(filePath)) {
        consoleOutput.debug(`File added: ${path.relative(directory, filePath)}`);
        logger.info('New file detected', { path: filePath, directory });
        this.indexQueue.add(() => this.indexFile(filePath));
      }
    });
    
    // Handle deleted files
    watcher.on('unlink', (filePath) => {
      consoleOutput.debug(`File deleted: ${path.relative(directory, filePath)}`);
      logger.info('File deleted', { path: filePath, directory });
      this.embeddingsIndex.removeFile(filePath);
    });
  }

  /**
   * Indexes a single file
   */
  private async indexFile(filePath: string): Promise<void> {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      
      // Skip very large files
      const maxSize = this.configManager.getConfig().maxIndexFileSize || 500000;
      if (content.length > maxSize) {
        consoleOutput.warning(`Skipping large file: ${path.basename(filePath)} (${content.length} bytes > ${maxSize} bytes)`);
        logger.logFileOperation('skip_large_file', filePath, true);
        logger.info('Skipped large file during indexing', { 
          path: filePath, 
          size: content.length, 
          maxSize 
        });
        return;
      }
      
      // Generate summary for the file
      logger.debug('Generating summary for file', { path: filePath, size: content.length });
      const summary = await this.generateFileSummary(filePath, content);
      
      // Generate embedding
      const embeddingInput = `${path.basename(filePath)}\n${summary}\n${content.substring(0, 8000)}`;
      logger.debug('Generating embedding for file', { path: filePath, inputSize: embeddingInput.length });
      const embedding = await this.openaiClient.generateEmbedding(embeddingInput);
      
      // Store in index
      this.embeddingsIndex.addEmbedding(filePath, embedding, content, summary);
      logger.info('File indexed successfully', { path: filePath, size: content.length });
      
    } catch (error) {
      consoleOutput.error(`Failed to index ${filePath}: ${error}`);
      logger.error(`Failed to index file`, error, { filePath });
    }
  }

  /**
   * Re-indexes a file if needed
   */
  private async reindexFile(filePath: string): Promise<void> {
    if (this.embeddingsIndex.needsReindex(filePath)) {
      logger.info('File needs re-indexing', { path: filePath });
      await this.indexFile(filePath);
    } else {
      logger.debug('File unchanged, skipping re-index', { path: filePath });
    }
  }

  /**
   * Sets up config file watching
   */
  private setupConfigWatcher(): void {
    const configPath = path.join(
      process.env.CAMILLE_CONFIG_DIR || path.join(os.homedir(), '.camille'),
      'config.json'
    );
    
    // Store initial config content
    try {
      this.lastConfigContent = fs.readFileSync(configPath, 'utf8');
    } catch (error) {
      logger.error('Failed to read initial config', error);
      return;
    }
    
    this.configWatcher = chokidar.watch(configPath, {
      persistent: true,
      ignoreInitial: true
    });
    
    this.configWatcher.on('change', async () => {
      try {
        const newContent = fs.readFileSync(configPath, 'utf8');
        
        // Check if content actually changed (avoid multiple events)
        if (newContent === this.lastConfigContent) {
          return;
        }
        
        this.lastConfigContent = newContent;
        consoleOutput.info(chalk.yellow('Configuration file changed, reloading...'));
        logger.info('Configuration file changed');
        
        // Reload configuration
        const newConfig = JSON.parse(newContent);
        const oldWatchedDirs = new Set(this.watchedDirectories);
        const newWatchedDirs = new Set<string>(newConfig.watchedDirectories || []);
        
        // Find directories to add
        for (const dir of newWatchedDirs) {
          if (!oldWatchedDirs.has(dir)) {
            consoleOutput.info(chalk.blue(`Adding new directory from config: ${dir}`));
            await this.addDirectory(dir);
          }
        }
        
        // Find directories to remove
        for (const dir of oldWatchedDirs) {
          if (!newWatchedDirs.has(dir)) {
            consoleOutput.info(chalk.blue(`Removing directory no longer in config: ${dir}`));
            await this.removeDirectory(dir);
          }
        }
        
        // Update other settings
        const config = this.configManager.getConfig();
        this.fileFilter = new FileFilter(config.ignorePatterns);
        this.llmClient = new LLMClient(config, process.cwd());
        this.openaiClient = new OpenAIClient(this.configManager.getApiKey(), config, process.cwd());
        
        consoleOutput.success('✅ Configuration reloaded');
        logger.info('Configuration reloaded successfully');
      } catch (error) {
        logger.error('Failed to reload configuration', error);
        consoleOutput.error('Failed to reload configuration: ' + error);
      }
    });
    
    consoleOutput.info(chalk.gray('Watching configuration file for changes'));
  }
  
  /**
   * Generates a summary of a file for better search
   */
  private async generateFileSummary(filePath: string, content: string): Promise<string> {
    // Generate a simple summary without using LLM to avoid complexity
    // File summaries are just for search context, not critical
    const ext = path.extname(filePath);
    const basename = path.basename(filePath);
    const lines = content.split('\n').length;
    const chars = content.length;
    
    // Extract first meaningful line (skip comments and empty lines)
    const meaningfulLines = content.split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('//') && !line.startsWith('#') && !line.startsWith('/*'));
    
    const preview = meaningfulLines[0] || '';
    
    return `${basename} - ${ext.slice(1).toUpperCase() || 'text'} file with ${lines} lines, ${chars} chars. ${preview.substring(0, 100)}`;
  }
}

/**
 * Server manager for running in background
 */
export class ServerManager {
  private static instance?: CamilleServer;
  private static pidFilePath: string = path.join(
    process.env.CAMILLE_CONFIG_DIR || path.join(os.homedir(), '.camille'),
    'server.pid'
  );

  /**
   * Starts the server if not already running
   */
  public static async start(directories: string | string[] = process.cwd()): Promise<CamilleServer> {
    // Check if another server is already running
    if (this.isServerRunning()) {
      throw new Error('Camille server is already running. Use "camille server stop" to stop it first.');
    }
    
    if (!this.instance) {
      this.instance = new CamilleServer();
      await this.instance.start(directories);
      
      // Write PID file
      this.writePidFile();
      logger.info('PID file written', { pid: process.pid, pidFile: this.pidFilePath });
    }
    return this.instance;
  }

  /**
   * Gets the running server instance
   */
  public static getInstance(): CamilleServer | undefined {
    return this.instance;
  }

  /**
   * Stops the server if running
   */
  public static async stop(): Promise<void> {
    // First try to stop the local instance
    if (this.instance) {
      await this.instance.stop();
      this.instance = undefined;
      this.removePidFile();
      return;
    }
    
    // If no local instance, try to stop by PID
    const pid = this.readPidFile();
    if (pid) {
      try {
        // Check if process exists
        process.kill(pid, 0);
        
        // Process exists, try to kill it
        consoleOutput.warning(`Stopping server process (PID: ${pid})...`);
        process.kill(pid, 'SIGTERM');
        
        // Give it time to gracefully shutdown
        let attempts = 0;
        while (attempts < 50) { // 5 seconds
          try {
            process.kill(pid, 0); // Check if still running
            await new Promise(resolve => setTimeout(resolve, 100));
            attempts++;
          } catch {
            // Process no longer exists
            break;
          }
        }
        
        // If still running, force kill
        try {
          process.kill(pid, 0);
          consoleOutput.warning('Server did not stop gracefully, forcing shutdown...');
          process.kill(pid, 'SIGKILL');
        } catch {
          // Process already gone
        }
        
        this.removePidFile();
        consoleOutput.success('✅ Camille server stopped');
      } catch (error: any) {
        if (error.code === 'ESRCH') {
          // Process doesn't exist
          consoleOutput.warning('Server process not found, cleaning up PID file...');
          this.removePidFile();
        } else if (error.code === 'EPERM') {
          // Permission denied
          throw new Error(`Permission denied to stop server process (PID: ${pid})`);
        } else {
          throw error;
        }
      }
    } else {
      consoleOutput.warning('No running Camille server found');
    }
  }
  
  /**
   * Checks if a server is running by checking the PID file
   */
  private static isServerRunning(): boolean {
    const pid = this.readPidFile();
    if (!pid) return false;
    
    try {
      // Check if process exists
      process.kill(pid, 0);
      return true;
    } catch {
      // Process doesn't exist, clean up stale PID file
      this.removePidFile();
      return false;
    }
  }
  
  /**
   * Writes the current process PID to file
   */
  private static writePidFile(): void {
    const dir = path.dirname(this.pidFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.pidFilePath, process.pid.toString());
    logger.info('PID file created', { pid: process.pid, file: this.pidFilePath });
  }
  
  /**
   * Reads the PID from file
   */
  private static readPidFile(): number | null {
    try {
      if (fs.existsSync(this.pidFilePath)) {
        const pid = parseInt(fs.readFileSync(this.pidFilePath, 'utf8').trim(), 10);
        return isNaN(pid) ? null : pid;
      }
    } catch (error) {
      logger.error('Failed to read PID file', error);
    }
    return null;
  }
  
  /**
   * Removes the PID file
   */
  private static removePidFile(): void {
    try {
      if (fs.existsSync(this.pidFilePath)) {
        fs.unlinkSync(this.pidFilePath);
      }
    } catch (error) {
      logger.error('Failed to remove PID file', error);
    }
  }
}