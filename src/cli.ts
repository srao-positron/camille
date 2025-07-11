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
  .command('set-key <key>')
  .description('Set your OpenAI API key')
  .action((key: string) => {
    try {
      const configManager = new ConfigManager();
      configManager.setApiKey(key);
      console.log(chalk.green('✅ OpenAI API key saved successfully'));
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
  .option('-d, --directory <path...>', 'Directories to watch and index (can specify multiple)')
  .option('--mcp', 'Also start the MCP server', false)
  .option('-q, --quiet', 'Suppress console output (daemon mode)', false)
  .action(async (options) => {
    try {
      // Determine which directories to watch
      let directoriesToWatch: string[];
      
      if (options.directory && options.directory.length > 0) {
        // Use explicitly provided directories
        directoriesToWatch = options.directory;
      } else {
        // Try to use configured directories
        const configManager = new ConfigManager();
        const config = configManager.getConfig();
        
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
      }
      
      // Set quiet mode if requested
      if (options.quiet) {
        process.env.CAMILLE_QUIET = 'true';
      }
      
      // Start the main server with directories
      await ServerManager.start(directoriesToWatch);
      
      // Let user know the server is ready for searches
      if (!options.quiet) {
        console.log(chalk.gray('\nServer is ready. You can now use MCP tools to search the indexed codebase.'));
      }

      // Start MCP server if requested
      if (options.mcp) {
        // When MCP flag is set, run in stdio mode for Claude Code
        // This means the server will communicate via stdin/stdout
        const mcpServer = new CamilleMCPServer();
        await mcpServer.start();
        // The server runs in stdio mode, so the process should not exit
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
        openaiApiKey: cfg.openaiApiKey ? '***' + cfg.openaiApiKey.slice(-4) : 'Not set'
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
});