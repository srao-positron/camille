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
  .option('-d, --directory <path>', 'Directory to watch and index', process.cwd())
  .option('--mcp', 'Also start the MCP server', false)
  .action(async (options) => {
    try {
      // Start the main server
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

// Parse command line arguments
program.parse(process.argv);

// Show help if no command provided
if (!process.argv.slice(2).length) {
  program.help();
}