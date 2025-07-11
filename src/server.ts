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
    const apiKey = this.configManager.getApiKey();
    
    this.openaiClient = new OpenAIClient(apiKey, config, process.cwd());
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
    
    // Set up named pipe path
    this.pipePath = process.platform === 'win32' 
      ? '\\\\.\\pipe\\camille-mcp'
      : path.join(os.tmpdir(), 'camille-mcp.sock');
  }

  /**
   * Starts the server with one or more directories
   */
  public async start(directories: string | string[] = process.cwd()): Promise<void> {
    consoleOutput.info(chalk.blue('🚀 Starting Camille server...'));
    logger.logServerEvent('server_starting', { directories });
    
    this.status.isRunning = true;
    
    // Normalize to array
    const dirsToWatch = Array.isArray(directories) ? directories : [directories];
    
    // Add all directories
    for (const dir of dirsToWatch) {
      await this.addDirectory(dir);
    }
    
    // If no directories to watch, mark index as ready
    if (dirsToWatch.length === 0) {
      this.embeddingsIndex.setReady(true);
    }
    
    // Wait for index to be ready before reporting server as started
    if (!this.embeddingsIndex.isIndexReady()) {
      consoleOutput.info(chalk.gray('Waiting for initial indexing to complete...'));
      // Poll until index is ready
      while (!this.embeddingsIndex.isIndexReady()) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    consoleOutput.success('✅ Camille server is running and index is ready');
    consoleOutput.info(chalk.gray(`Indexed files: ${this.embeddingsIndex.getIndexSize()}`));
    
    // Start the named pipe server for MCP communication
    await this.startPipeServer();
    
    logger.logServerEvent('server_started', { 
      directories: this.getWatchedDirectories(),
      indexSize: this.embeddingsIndex.getIndexSize() 
    });
    
    // Set up config file watching
    this.setupConfigWatcher();
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
      logger.info('MCP client connected via named pipe');
      
      let buffer = '';
      
      socket.on('data', async (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        
        // Process complete lines
        while (lines.length > 1) {
          const line = lines.shift()!;
          if (line.trim()) {
            try {
              const request = JSON.parse(line);
              const response = await this.handleMCPRequest(request);
              socket.write(JSON.stringify(response) + '\n');
            } catch (error) {
              logger.error('Error handling MCP request', error);
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
        logger.error('Named pipe socket error', error);
      });
      
      socket.on('close', () => {
        logger.info('MCP client disconnected');
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
    logger.debug('Handling MCP request', { method: request.method });
    
    // Import MCP handlers
    const { CamilleMCPServer } = require('./mcp-server');
    const mcpServer = new CamilleMCPServer();
    
    // Route the request to appropriate handler
    if (request.method === 'tools/list') {
      return mcpServer['server'].handleRequest(request);
    } else if (request.method === 'tools/call') {
      const { name, arguments: args } = request.params;
      
      switch (name) {
        case 'camille_search_code':
          // Use our local embeddings index
          return await this.handleSearchCode(args);
          
        case 'camille_validate_changes':
          // Forward to hook for validation
          const { CamilleHook } = require('./hook');
          const hook = new CamilleHook();
          return await this.handleValidateChanges(args, hook);
          
        case 'camille_status':
          return {
            jsonrpc: '2.0',
            result: {
              running: true,
              indexReady: this.embeddingsIndex.isIndexReady(),
              indexing: this.status.isIndexing,
              filesIndexed: this.embeddingsIndex.getIndexSize(),
              queueSize: this.indexQueue.size
            },
            id: request.id
          };
          
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    }
    
    throw new Error(`Unknown method: ${request.method}`);
  }

  /**
   * Handles code search requests
   */
  private async handleSearchCode(args: any): Promise<any> {
    const { query, limit = 10 } = args;
    
    if (!this.embeddingsIndex.isIndexReady()) {
      return {
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Index is still building. Please wait for initial indexing to complete.'
        }
      };
    }
    
    try {
      const queryEmbedding = await this.openaiClient.generateEmbedding(query);
      const results = this.embeddingsIndex.search(queryEmbedding, limit);
      
      return {
        jsonrpc: '2.0',
        result: {
          results: results.map((result: SearchResult) => ({
            path: path.relative(process.cwd(), result.path),
            similarity: result.similarity.toFixed(3),
            summary: result.summary || 'No summary available',
            preview: result.content.substring(0, 200) + '...'
          })),
          totalFiles: this.embeddingsIndex.getIndexSize()
        }
      };
    } catch (error) {
      return {
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: `Search failed: ${error instanceof Error ? error.message : 'Unknown error'}`
        }
      };
    }
  }

  /**
   * Handles validation requests
   */
  private async handleValidateChanges(args: any, hook: any): Promise<any> {
    const { filePath, changes, changeType } = args;
    
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

      return {
        jsonrpc: '2.0',
        result: {
          approved: result.decision === 'approve',
          reason: result.reason,
          needsChanges: result.decision === 'block',
          details: this.parseValidationDetails(result.reason || '')
        }
      };
    } catch (error) {
      return {
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: `Validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`
        }
      };
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
      for (const file of filesToIndex) {
        this.indexQueue.add(async () => {
          await this.indexFile(file);
          processed++;
          if (this.spinner) {
            this.spinner.text = `Indexing files... (${processed}/${filesToIndex.length})`;
          }
        });
      }
      
      // Wait for all indexing to complete
      await this.indexQueue.onIdle();
      
      if (this.spinner) this.spinner.succeed(`Indexed ${filesToIndex.length} files`);
      consoleOutput.success(`Indexed ${filesToIndex.length} files`);
      logger.logServerEvent('indexing_completed', { 
        directory, 
        filesIndexed: filesToIndex.length 
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
      await this.indexFile(filePath);
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
    const truncatedContent = content.substring(0, 4000);
    const prompt = `${EMBEDDING_PROMPT}\n\nFile: ${path.basename(filePath)}\nContent:\n${truncatedContent}`;
    
    try {
      const summary = await this.openaiClient.complete(prompt);
      return summary.substring(0, 500); // Limit summary length
    } catch (error) {
      logger.error('Failed to generate summary', error, { filePath });
      return '';
    }
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