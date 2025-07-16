#!/usr/bin/env node

/**
 * CLI interface for Camille
 * Provides commands for configuration, server management, and help
 */

import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ConfigManager } from './config';
import { ServerManager } from './server';
import { CamilleMCPServer } from './mcp-server';
import { runHook } from './hook';
import { runSetupWizard } from './setup-wizard';
import { logger } from './logger';
import { getModelsForProvider, getRecommendedModels, LLMProvider } from './providers';

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

/**
 * Main CLI program
 */
const program = new Command();

program
  .name('camille')
  .description('An intelligent code compliance checker and embedding search tool for Claude Code')
  .version(pkg.version);

/**
 * Set API key command
 */
program
  .command('set-key <key> [provider]')
  .description('Set API key for a provider (defaults to current provider)')
  .action((key: string, provider?: string) => {
    try {
      const configManager = new ConfigManager();
      
      // Validate provider if specified
      if (provider && !['anthropic', 'openai'].includes(provider)) {
        console.error(chalk.red(`Invalid provider: ${provider}. Must be 'anthropic' or 'openai'`));
        process.exit(1);
      }
      
      const targetProvider = provider as 'anthropic' | 'openai' | undefined;
      configManager.setApiKey(key, targetProvider);
      
      const actualProvider = targetProvider || configManager.getProvider();
      console.log(chalk.green(`✅ ${actualProvider === 'anthropic' ? 'Anthropic' : 'OpenAI'} API key saved successfully`));
      console.log(chalk.gray(`Configuration stored in: ${path.join(require('os').homedir(), '.camille')}`));
    } catch (error) {
      console.error(chalk.red('Error:', error));
      process.exit(1);
    }
  });

/**
 * Server commands
 */
const server = program
  .command('server')
  .description('Manage the Camille server');

server
  .command('start')
  .description('Start the Camille server with file watching and indexing')
  .option('-d, --directory <path...>', 'Directories to watch (ignored - uses config)', [])
  .option('-q, --quiet', 'Suppress console output (daemon mode)', false)
  .option('--mcp', 'Enable MCP server mode (always enabled)', true)
  .action(async (options) => {
    try {
      // Check if running as root
      if (process.getuid && process.getuid() === 0) {
        console.error(chalk.red('\n❌ Do not run the server with sudo!'));
        console.error(chalk.yellow('\nThis will cause permission issues.'));
        console.error(chalk.cyan('\nIf you have permission errors, run:'));
        console.error(chalk.gray('  ./fix-permissions.sh\n'));
        process.exit(1);
      }
      
      // Always use configured directories
      const configManager = new ConfigManager();
      const config = configManager.getConfig();
      let directoriesToWatch: string[];
      
      if (config.watchedDirectories && config.watchedDirectories.length > 0) {
        directoriesToWatch = config.watchedDirectories;
        if (!options.quiet) {
          console.log(chalk.gray('Using configured directories from ~/.camille/config.json'));
        }
      } else {
        // Fall back to current directory
        directoriesToWatch = [process.cwd()];
        if (!options.quiet) {
          console.log(chalk.gray('No directories configured, using current directory'));
        }
      }
      
      // Set quiet mode if requested
      if (options.quiet) {
        process.env.CAMILLE_QUIET = 'true';
      }
      
      // Start the main server with directories
      await ServerManager.start(directoriesToWatch);
      
      // Let user know the server is ready for searches
      if (!options.quiet) {
        console.log(chalk.gray('\nServer is ready. The named pipe is listening for MCP connections.'));
        console.log(chalk.gray('You can now use MCP tools to search the indexed codebase.'));
      }

      // Keep the process running and handle various termination signals
      const shutdown = async (signal: string) => {
        if (!options.quiet) {
          console.log(chalk.yellow(`\nReceived ${signal}, shutting down...`));
        }
        await ServerManager.stop();
        process.exit(0);
      };
      
      process.on('SIGINT', () => shutdown('SIGINT'));
      process.on('SIGTERM', () => shutdown('SIGTERM'));
      process.on('SIGHUP', () => shutdown('SIGHUP'));
      
      // Clean up on unexpected exit
      process.on('exit', () => {
        // Synchronous cleanup only
        try {
          const fs = require('fs');
          const path = require('path');
          const os = require('os');
          const pidFile = path.join(
            process.env.CAMILLE_CONFIG_DIR || path.join(os.homedir(), '.camille'),
            'server.pid'
          );
          if (fs.existsSync(pidFile)) {
            const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
            if (pid === process.pid) {
              fs.unlinkSync(pidFile);
            }
          }
        } catch {
          // Ignore errors during cleanup
        }
      });

    } catch (error) {
      console.error(chalk.red('Error:', error));
      process.exit(1);
    }
  });

server
  .command('stop')
  .description('Stop the Camille server')
  .action(async () => {
    try {
      await ServerManager.stop();
    } catch (error) {
      console.error(chalk.red('Error:', error));
      process.exit(1);
    }
  });

server
  .command('reindex-edges')
  .description('Re-parse all files and run second pass edge processing')
  .action(async () => {
    try {
      // Use the API endpoint to trigger re-indexing
      const http = await import('http');
      
      const data = await new Promise<any>((resolve, reject) => {
        const req = http.request({
          hostname: 'localhost',
          port: 3456,
          path: '/api/reindex-edges',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        }, (res) => {
          let body = '';
          res.on('data', (chunk) => body += chunk);
          res.on('end', () => {
            try {
              const result = JSON.parse(body);
              if (res.statusCode && res.statusCode >= 400) {
                reject(new Error(result.error || `HTTP ${res.statusCode}`));
              } else {
                resolve(result);
              }
            } catch (e) {
              reject(e);
            }
          });
        });
        
        req.on('error', (err) => {
          if ((err as any).code === 'ECONNREFUSED') {
            const customErr = new Error('Connection refused');
            (customErr as any).code = 'ECONNREFUSED';
            reject(customErr);
          } else {
            reject(err);
          }
        });
        
        req.end();
      });
      
      console.log(chalk.blue(data.message));
      console.log(chalk.gray('Check server logs for progress...'));
    } catch (error: any) {
      if (error.code === 'ECONNREFUSED') {
        console.error(chalk.red('Error: Could not connect to Camille API server on port 3456'));
        console.error(chalk.yellow('Make sure the server is running with "camille server start"'));
      } else {
        console.error(chalk.red('Error:', error.message));
      }
      process.exit(1);
    }
  });

server
  .command('restart')
  .description('Restart the Camille server (stop and start)')
  .action(async () => {
    try {
      console.log(chalk.blue('Restarting Camille server...'));
      
      // First stop the server
      console.log(chalk.gray('Stopping server...'));
      await ServerManager.stop();
      
      // Wait a moment for cleanup
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Clear the log files for fresh debugging
      const logFiles = ['/tmp/camille-proxy.log', '/tmp/camille-mcp-server.log'];
      for (const logFile of logFiles) {
        if (fs.existsSync(logFile)) {
          fs.writeFileSync(logFile, `=== SERVER RESTARTED AT ${new Date().toISOString()} ===\n\n`);
          console.log(chalk.gray(`Cleared log file: ${logFile}`));
        }
      }
      
      // Start the server in background
      console.log(chalk.gray('Starting server in background...'));
      
      // Use child_process to start server in background
      const { spawn } = require('child_process');
      const serverProcess = spawn('nohup', ['camille', 'server', 'start'], {
        detached: true,
        stdio: ['ignore', fs.openSync('/tmp/camille-server.out', 'a'), fs.openSync('/tmp/camille-server.out', 'a')]
      });
      
      serverProcess.unref();
      
      // Wait a moment for server to start
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Check if server started successfully
      const pidFilePath = path.join(os.homedir(), '.camille', 'server.pid');
      if (fs.existsSync(pidFilePath)) {
        const pid = parseInt(fs.readFileSync(pidFilePath, 'utf8').trim(), 10);
        console.log(chalk.green(`✅ Server restarted successfully (PID: ${pid})`));
      } else {
        console.log(chalk.green('✅ Server restart initiated'));
      }
      
      console.log(chalk.gray('Log files:'));
      console.log(chalk.gray('  - MCP Server: /tmp/camille-mcp-server.log'));
      console.log(chalk.gray('  - Python Proxy: /tmp/camille-proxy.log'));
      console.log(chalk.gray('  - General: /tmp/camille.log'));
    } catch (error) {
      console.error(chalk.red('Error restarting server:', error));
      process.exit(1);
    }
  });

server
  .command('status')
  .description('Check server status')
  .action(async () => {
    
    const instance = ServerManager.getInstance();
    
    // Check for PID file if no local instance
    if (!instance) {
      const pidFilePath = path.join(
        process.env.CAMILLE_CONFIG_DIR || path.join(require('os').homedir(), '.camille'),
        'server.pid'
      );
      
      if (fs.existsSync(pidFilePath)) {
        try {
          const pid = parseInt(fs.readFileSync(pidFilePath, 'utf8').trim(), 10);
          // Check if process is running
          process.kill(pid, 0);
          console.log(chalk.blue('Server Status:'));
          console.log(`  Running: ${chalk.green('Yes')} (PID: ${pid})`);
          console.log(`  Note: Server is running in another process. Use "camille server stop" to stop it.`);
          return;
        } catch {
          // Process not running, clean up stale PID file
          fs.unlinkSync(pidFilePath);
          console.log(chalk.yellow('Server is not running (cleaned up stale PID file)'));
          return;
        }
      }
      
      console.log(chalk.yellow('Server is not running'));
      return;
    }

    const status = instance.getStatus();
    console.log(chalk.blue('Server Status:'));
    console.log(`  Running: ${status.isRunning ? chalk.green('Yes') : chalk.red('No')} (PID: ${process.pid})`);
    console.log(`  Indexing: ${status.isIndexing ? chalk.yellow('In progress') : chalk.green('Complete')}`);
    console.log(`  Files indexed: ${chalk.cyan(status.indexSize)}`);
    console.log(`  Queue size: ${chalk.cyan(status.queueSize)}`);
    console.log(`  Watched directories: ${chalk.cyan(status.watchedDirectories.length)}`);
    if (status.watchedDirectories.length > 0) {
      status.watchedDirectories.forEach(dir => {
        console.log(`    - ${chalk.gray(dir)}`);
      });
    }
  });

server
  .command('add-directory <path...>')
  .description('Add directories to watch')
  .action(async (paths: string[]) => {
    try {
      const instance = ServerManager.getInstance();
      if (!instance) {
        console.log(chalk.yellow('Server is not running. Start it first with "camille server start"'));
        return;
      }

      for (const dirPath of paths) {
        await instance.addDirectory(dirPath);
      }
    } catch (error) {
      console.error(chalk.red('Error:', error));
      process.exit(1);
    }
  });

server
  .command('remove-directory <path...>')
  .description('Remove directories from watching')
  .action(async (paths: string[]) => {
    try {
      const instance = ServerManager.getInstance();
      if (!instance) {
        console.log(chalk.yellow('Server is not running'));
        return;
      }

      for (const dirPath of paths) {
        await instance.removeDirectory(dirPath);
      }
    } catch (error) {
      console.error(chalk.red('Error:', error));
      process.exit(1);
    }
  });

/**
 * Config commands
 */
const config = program
  .command('config')
  .description('Manage Camille configuration');

config
  .command('show')
  .description('Show current configuration')
  .action(() => {
    try {
      const configManager = new ConfigManager();
      const cfg = configManager.getConfig();
      console.log(chalk.blue('Current Configuration:'));
      console.log(JSON.stringify({
        ...cfg,
        openaiApiKey: cfg.openaiApiKey ? '***' + cfg.openaiApiKey.slice(-4) : 'Not set',
        anthropicApiKey: cfg.anthropicApiKey ? '***' + cfg.anthropicApiKey.slice(-4) : 'Not set'
      }, null, 2));
    } catch (error) {
      console.error(chalk.red('Error:', error));
      process.exit(1);
    }
  });

config
  .command('set <key> <value>')
  .description('Set a configuration value')
  .action((key: string, value: string) => {
    try {
      const configManager = new ConfigManager();
      const updates: any = {};
      
      // Parse nested keys
      const keys = key.split('.');
      let current = updates;
      for (let i = 0; i < keys.length - 1; i++) {
        current[keys[i]] = current[keys[i]] || {};
        current = current[keys[i]];
      }
      
      // Try to parse JSON values
      try {
        current[keys[keys.length - 1]] = JSON.parse(value);
      } catch {
        current[keys[keys.length - 1]] = value;
      }
      
      configManager.updateConfig(updates);
      console.log(chalk.green('✅ Configuration updated'));
    } catch (error) {
      console.error(chalk.red('Error:', error));
      process.exit(1);
    }
  });

config
  .command('set-provider <provider>')
  .description('Set the LLM provider (anthropic or openai)')
  .action((provider: string) => {
    try {
      if (!['anthropic', 'openai'].includes(provider)) {
        console.error(chalk.red(`Invalid provider: ${provider}. Must be 'anthropic' or 'openai'`));
        process.exit(1);
      }
      
      const configManager = new ConfigManager();
      configManager.setProvider(provider as 'anthropic' | 'openai');
      console.log(chalk.green(`✅ Provider set to ${provider}`));
      
      // Check if API key is configured for this provider
      const config = configManager.getConfig();
      if (provider === 'anthropic' && !config.anthropicApiKey) {
        console.log(chalk.yellow('\n⚠️  No Anthropic API key configured'));
        console.log(chalk.gray('Run: camille set-key <your-key> anthropic'));
      } else if (provider === 'openai' && !config.openaiApiKey) {
        console.log(chalk.yellow('\n⚠️  No OpenAI API key configured'));
        console.log(chalk.gray('Run: camille set-key <your-key> openai'));
      }
    } catch (error) {
      console.error(chalk.red('Error:', error));
      process.exit(1);
    }
  });

config
  .command('set-model <type> <model>')
  .description('Set model for a specific use case (review or quick)')
  .action((type: string, model: string) => {
    try {
      if (!['review', 'quick'].includes(type)) {
        console.error(chalk.red(`Invalid type: ${type}. Must be 'review' or 'quick'`));
        process.exit(1);
      }
      
      const configManager = new ConfigManager();
      const config = configManager.getConfig();
      const provider = config.provider || 'openai';
      const availableModels = getModelsForProvider(provider);
      
      // Validate model exists for provider
      const modelInfo = availableModels.find(m => m.id === model);
      if (!modelInfo) {
        console.error(chalk.red(`Model '${model}' not available for provider '${provider}'`));
        console.log(chalk.gray('\nAvailable models:'));
        availableModels.forEach(m => {
          console.log(chalk.gray(`  - ${m.id} (${m.name})`));
        });
        process.exit(1);
      }
      
      // Update model config
      const updates = {
        models: {
          ...config.models,
          [type]: model
        }
      };
      configManager.updateConfig(updates);
      console.log(chalk.green(`✅ ${type} model set to ${model}`));
    } catch (error) {
      console.error(chalk.red('Error:', error));
      process.exit(1);
    }
  });

config
  .command('list-models [provider]')
  .description('List available models for a provider')
  .action((provider?: string) => {
    try {
      const configManager = new ConfigManager();
      const targetProvider = provider || configManager.getProvider();
      
      if (provider && !['anthropic', 'openai'].includes(provider)) {
        console.error(chalk.red(`Invalid provider: ${provider}. Must be 'anthropic' or 'openai'`));
        process.exit(1);
      }
      
      const models = getModelsForProvider(targetProvider as LLMProvider);
      const recommended = getRecommendedModels(targetProvider as LLMProvider);
      
      console.log(chalk.blue(`\nAvailable models for ${targetProvider}:\n`));
      
      // Group by use case
      const reviewModels = models.filter(m => m.supportsTools);
      const quickModels = models.filter(m => m.supportsTools && m.pricing.input <= 5);
      const embeddingModels = models.filter(m => m.id.includes('embedding'));
      
      if (reviewModels.length > 0) {
        console.log(chalk.yellow('Code Review Models:'));
        reviewModels.forEach(m => {
          const isRecommended = m.id === recommended.review.id;
          console.log(`  ${chalk.cyan(m.id)} - ${m.name}`);
          console.log(`    Price: $${m.pricing.input}/$${m.pricing.output} per 1M tokens`);
          if (m.description) {
            console.log(`    ${chalk.gray(m.description)}`);
          }
          if (isRecommended) {
            console.log(`    ${chalk.green('✓ Recommended')}`);
          }
          console.log();
        });
      }
      
      if (quickModels.length > 0) {
        console.log(chalk.yellow('Quick Check Models:'));
        quickModels.forEach(m => {
          const isRecommended = m.id === recommended.quick.id;
          console.log(`  ${chalk.cyan(m.id)} - ${m.name}`);
          console.log(`    Price: $${m.pricing.input}/$${m.pricing.output} per 1M tokens`);
          if (isRecommended) {
            console.log(`    ${chalk.green('✓ Recommended')}`);
          }
          console.log();
        });
      }
      
      if (embeddingModels.length > 0 && targetProvider === 'openai') {
        console.log(chalk.yellow('Embedding Models:'));
        embeddingModels.forEach(m => {
          const isRecommended = recommended.embedding && m.id === recommended.embedding.id;
          console.log(`  ${chalk.cyan(m.id)} - ${m.name}`);
          console.log(`    Price: $${m.pricing.input} per 1M tokens`);
          if (isRecommended) {
            console.log(`    ${chalk.green('✓ Recommended')}`);
          }
          console.log();
        });
      }
    } catch (error) {
      console.error(chalk.red('Error:', error));
      process.exit(1);
    }
  });

/**
 * Hook command (for Claude Code integration)
 */
program
  .command('hook', { hidden: true })
  .description('Run as a Claude Code hook (internal use)')
  .action(async () => {
    await runHook();
  });

/**
 * Memory hook command (for PreCompact hook)
 */
program
  .command('memory-hook', { hidden: true })
  .description('Run as a Claude Code PreCompact hook (internal use)')
  .action(async () => {
    // Read input from stdin
    let input = '';
    process.stdin.setEncoding('utf8');
    
    for await (const chunk of process.stdin) {
      input += chunk;
    }
    
    if (!input) {
      console.error('No input provided to memory hook');
      process.exit(2);
    }
    
    // Import and run the PreCompact hook
    const { PreCompactHook } = await import('./memory/hooks/precompact-hook.js');
    const hook = new PreCompactHook();
    const parsedInput = JSON.parse(input);
    await hook.run(parsedInput);
  });

/**
 * Setup command
 */
program
  .command('setup')
  .description('Run the interactive setup wizard')
  .action(async () => {
    try {
      await runSetupWizard();
    } catch (error) {
      logger.error('Setup failed', error);
      console.error(chalk.red('Setup failed:', error));
      process.exit(1);
    }
  });

/**
 * Init MCP command
 */
program
  .command('init-mcp [directory]')
  .description('Add Camille MCP server to Claude Code')
  .option('-s, --scope <scope>', 'Configuration scope: user, project, or local', 'local')
  .action(async (directory?: string, options?: any) => {
    const { execSync } = require('child_process');
    const targetDir = directory ? path.resolve(directory) : process.cwd();
    
    if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
      console.error(chalk.red('Error: Not a valid directory'));
      process.exit(1);
    }
    
    // Check if claude command is available
    try {
      execSync('claude --version', { stdio: 'ignore' });
    } catch {
      console.error(chalk.red('Error: Claude Code CLI not found. Please install Claude Code first.'));
      console.log(chalk.gray('Visit: https://docs.anthropic.com/en/docs/claude-code/quickstart'));
      process.exit(1);
    }
    
    // Build the command
    const args = ['mcp', 'add'];
    
    // Add scope
    const scope = options?.scope || 'local';
    args.push('--scope', scope);
    
    // Add environment variable if API key is configured
    const config = new ConfigManager();
    const apiKey = config.getConfig().openaiApiKey;
    if (apiKey) {
      args.push('-e', `OPENAI_API_KEY=${apiKey}`);
    }
    
    // Add server name and command
    args.push('camille', '--', 'camille', 'server', 'start', '--mcp');
    
    try {
      console.log(chalk.gray(`Adding Camille MCP server at ${scope} level...`));
      
      // For local scope, run in the target directory
      const execOptions = scope === 'local' ? { cwd: targetDir, stdio: 'inherit' } : { stdio: 'inherit' };
      execSync(`claude ${args.join(' ')}`, execOptions);
      
      console.log(chalk.green(`✅ Added Camille MCP server`));
      if (scope === 'local') {
        console.log(chalk.gray(`Location: ${targetDir}`));
      }
      console.log(chalk.gray(`Scope: ${scope}`));
      
      if (!apiKey) {
        console.log(chalk.yellow('\n⚠ No OpenAI API key configured. Run "camille config set" to add one.'));
      }
    } catch (error) {
      console.error(chalk.red('Failed to add MCP server:'));
      console.error(chalk.gray((error as Error).message));
      process.exit(1);
    }
  });

/**
 * Help command with subcommands
 */
const help = program
  .command('help [topic]')
  .description('Show detailed help information')
  .action((topic?: string) => {
    if (topic === 'mcp') {
      showMCPHelp();
    } else {
      const helpPath = path.join(__dirname, '..', 'README.md');
      if (fs.existsSync(helpPath)) {
        const readme = fs.readFileSync(helpPath, 'utf8');
        // Convert markdown to plain text (basic conversion)
        const plainText = readme
          .replace(/^#+\s+/gm, '')
          .replace(/\*\*([^*]+)\*\*/g, '$1')
          .replace(/\*([^*]+)\*/g, '$1')
          .replace(/`([^`]+)`/g, '$1')
          .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
        
        console.log(plainText);
      } else {
        program.help();
      }
    }
  });

/**
 * Show MCP-specific help
 */
function showMCPHelp() {
  console.log(chalk.blue.bold('\n🤖 MCP (Model Context Protocol) Setup Guide\n'));
  
  console.log(chalk.yellow('What is MCP?'));
  console.log('MCP allows Claude to use Camille\'s code search and validation tools directly.');
  console.log('When configured, you can ask Claude to search your codebase or validate changes.\n');
  
  console.log(chalk.yellow('How it works:'));
  console.log('• One central Camille server runs as a system service');
  console.log('• Each project\'s .mcp.json connects Claude Code to this central service');
  console.log('• Claude Code uses a named pipe - no new servers are spawned');
  console.log('• All projects share the same indexed codebase\n');
  
  console.log(chalk.yellow('Setup Instructions for Claude Code:'));
  console.log('\n1. Ensure the central Camille server is running:');
  console.log(chalk.cyan('   camille server start --mcp\n'));
  
  console.log('2. Create a .mcp.json file in your project root:');
  console.log(chalk.gray(`   {
     "mcpServers": {
       "camille": {
         "transport": "pipe",
         "pipeName": "${process.platform === 'win32' ? '\\\\.\\pipe\\camille-mcp' : '/tmp/camille-mcp.sock'}"
       }
     }
   }\n`));
  
  console.log('3. Or use the quick setup command:');
  console.log(chalk.cyan('   camille init-mcp\n'));
  
  console.log(chalk.yellow('Project vs User Scope:'));
  console.log('• Project scope (default): .mcp.json in project root - shared with team');
  console.log('• User scope: Add "scope": "user" to configuration - personal only\n');
  
  console.log(chalk.yellow('Available MCP Tools:'));
  console.log('\n• ' + chalk.green('camille_search_code'));
  console.log('  Search for code using natural language');
  console.log('  Example: "Find authentication code"\n');
  
  console.log('• ' + chalk.green('camille_validate_changes'));
  console.log('  Validate code changes for security and compliance');
  console.log('  Example: "Check if this code is secure"\n');
  
  console.log('• ' + chalk.green('camille_status'));
  console.log('  Check server and index status');
  console.log('  Example: "Is Camille running?"\n');
  
  console.log(chalk.yellow('Troubleshooting:'));
  console.log('• Ensure Camille is installed globally: npm install -g camille');
  console.log('• Check logs at: /tmp/camille.log');
  console.log('• Verify API key is set: camille config show');
  console.log('• API key is loaded from ~/.camille/config.json automatically\n');
  
  console.log(chalk.dim('For more details, see: https://github.com/srao-positron/camille/blob/main/docs/mcp-setup.md'));
}

/**
 * Default action
 */
program
  .action(() => {
    program.help();
  });

// Check for first run before parsing
async function checkFirstRun() {
  try {
    const configManager = new ConfigManager();
    const config = configManager.getConfig();
    
    // If no API key is configured and no command specified, run setup
    if (!config.openaiApiKey && process.argv.length === 2) {
      console.log(chalk.yellow('\n👋 Welcome to Camille! It looks like this is your first time.'));
      console.log(chalk.gray('Let\'s get you set up...\n'));
      await runSetupWizard();
      process.exit(0);
    }
  } catch (error) {
    // If config doesn't exist, this is definitely first run
    if (process.argv.length === 2) {
      console.log(chalk.yellow('\n👋 Welcome to Camille! Let\'s get you set up.'));
      await runSetupWizard();
      process.exit(0);
    }
  }
}

// Run first-run check
checkFirstRun().then(() => {
  // Parse command line arguments
  program.parse(process.argv);

  // Show help if no command provided
  if (!process.argv.slice(2).length) {
    program.help();
  }
}).catch(error => {
  logger.error('CLI error', error);
  console.error(chalk.red('Error:', error));
  process.exit(1);
});// test comment
