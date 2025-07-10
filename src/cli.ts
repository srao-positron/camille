#!/usr/bin/env node

/**
 * CLI interface for Camille
 * Provides commands for configuration, server management, and help
 */

import { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
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
  .option('-d, --directory <path...>', 'Directories to watch and index (can specify multiple)', [process.cwd()])
  .option('--mcp', 'Also start the MCP server', false)
  .action(async (options) => {
    try {
      // Start the main server with directories
      await ServerManager.start(options.directory);

      // Start MCP server if requested
      if (options.mcp) {
        const mcpServer = new CamilleMCPServer();
        await mcpServer.start();
        
        console.log(chalk.blue('\n📡 MCP Server Configuration:'));
        console.log(chalk.gray('Add this to your Claude Code settings:'));
        console.log(chalk.yellow(`
{
  "mcpServers": {
    "camille": {
      "transport": "pipe",
      "pipeName": "${mcpServer.getPipePath()}"
    }
  }
}
`));
      }

      // Keep the process running
      process.on('SIGINT', async () => {
        console.log(chalk.yellow('\nShutting down...'));
        await ServerManager.stop();
        process.exit(0);
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
  .action(() => {
    const instance = ServerManager.getInstance();
    if (!instance) {
      console.log(chalk.yellow('Server is not running'));
      return;
    }

    const status = instance.getStatus();
    console.log(chalk.blue('Server Status:'));
    console.log(`  Running: ${status.isRunning ? chalk.green('Yes') : chalk.red('No')}`);
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
 * Help command
 */
program
  .command('help')
  .description('Show detailed help information')
  .action(() => {
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
  });

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