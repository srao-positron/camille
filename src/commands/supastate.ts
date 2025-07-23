/**
 * Supastate CLI commands for Camille integration
 */

import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';
import path from 'path';
import os from 'os';
import { ConfigManager } from '../config.js';
import { SupastateClient } from '../services/supastate-client.js';
import { createSupastateLoginCommand } from './supastate-login.js';

export function createSupastateCommand(): Command {
  const supastate = new Command('supastate')
    .description('Manage Supastate cloud integration');

  // Add the login subcommand
  supastate.addCommand(createSupastateLoginCommand());

  /**
   * Enable Supastate integration
   */
  supastate
    .command('enable')
    .description('Enable and configure Supastate integration')
    .action(async () => {
      const spinner = ora('Configuring Supastate...').start();
      
      try {
        spinner.stop();
        
        // Prompt for configuration
        const answers = await inquirer.prompt([
          {
            type: 'input',
            name: 'url',
            message: 'Supastate URL:',
            default: 'https://supastate.vercel.app',
            validate: (input) => {
              try {
                new URL(input);
                return true;
              } catch {
                return 'Please enter a valid URL';
              }
            },
          },
          {
            type: 'input',
            name: 'apiKey',
            message: 'API Key:',
            validate: (input) => input.length > 0 || 'API key is required',
          },
          {
            type: 'input',
            name: 'teamId',
            message: 'Team ID:',
            validate: (input) => input.length > 0 || 'Team ID is required',
          },
          {
            type: 'confirm',
            name: 'autoSync',
            message: 'Enable automatic sync?',
            default: true,
          },
        ]);

        if (answers.autoSync) {
          const syncInterval = await inquirer.prompt([
            {
              type: 'number',
              name: 'interval',
              message: 'Sync interval (minutes):',
              default: 30,
              validate: (input) => input > 0 || 'Interval must be greater than 0',
            },
          ]);
          answers.syncInterval = syncInterval.interval;
        }

        // Update configuration
        const configManager = new ConfigManager();
        configManager.updateConfig({
          supastate: {
            enabled: true,
            url: answers.url,
            apiKey: answers.apiKey,
            teamId: answers.teamId,
            autoSync: answers.autoSync,
            syncInterval: answers.syncInterval,
          },
        });

        // Test connection
        spinner.start('Testing connection...');
        const client = new SupastateClient();
        const connected = await client.testConnection();
        spinner.stop();

        if (connected) {
          console.log(chalk.green('✅ Supastate integration enabled successfully!'));
          console.log(chalk.gray(`Configuration saved to: ${path.join(os.homedir(), '.camille/config.json')}`));
          
          if (answers.autoSync) {
            console.log(chalk.gray(`Auto-sync enabled (every ${answers.syncInterval} minutes)`));
            console.log(chalk.yellow('\n⚠️  Note: Auto-sync will start when the Camille server is running'));
          }
        } else {
          console.log(chalk.yellow('⚠️  Configuration saved but connection test failed'));
          console.log(chalk.gray('Please check your URL and API key'));
        }
      } catch (error) {
        spinner.fail('Configuration failed');
        console.error(chalk.red('Error:'), error);
        process.exit(1);
      }
    });

  /**
   * Disable Supastate integration
   */
  supastate
    .command('disable')
    .description('Disable Supastate integration')
    .action(async () => {
      const confirm = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'proceed',
          message: 'Are you sure you want to disable Supastate integration?',
          default: false,
        },
      ]);

      if (!confirm.proceed) {
        console.log(chalk.gray('Cancelled'));
        return;
      }

      const configManager = new ConfigManager();
      configManager.updateConfig({
        supastate: {
          enabled: false,
        },
      });

      console.log(chalk.yellow('⏹ Supastate integration disabled'));
    });

  /**
   * Manual sync command
   */
  supastate
    .command('sync')
    .description('Manually sync memories and graphs to Supastate')
    .option('-m, --memories-only', 'Only sync memories')
    .option('-g, --graphs-only', 'Only sync code graphs')
    .action(async (options) => {
      const spinner = ora('Triggering sync...').start();
      
      try {
        const configManager = new ConfigManager();
        const config = configManager.getConfig();
        
        if (!config.supastate?.enabled) {
          spinner.fail('Supastate not enabled');
          console.log(chalk.gray('Run "camille supastate login" first'));
          process.exit(1);
        }

        // Check if server is running
        const apiUrl = 'http://localhost:3456';
        try {
          const response = await fetch(`${apiUrl}/api/health`);
          if (!response.ok) {
            throw new Error('Server not responding');
          }
        } catch (error) {
          spinner.fail('Camille server not running');
          console.log(chalk.gray('Start the server with "camille server start"'));
          process.exit(1);
        }

        // Trigger sync via API
        const syncResponse = await fetch(`${apiUrl}/api/supastate/sync`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            memoriesOnly: options.memoriesOnly,
            graphsOnly: options.graphsOnly,
          }),
        });

        if (!syncResponse.ok) {
          const error = await syncResponse.json() as any;
          throw new Error(error.error || 'Sync request failed');
        }

        const result = await syncResponse.json() as any;
        spinner.succeed(`Sync started in background (mode: ${result.mode})`);
        
        console.log(chalk.gray('\nUse "camille supastate status" to check sync progress'));
      } catch (error: unknown) {
        spinner.fail('Sync failed');
        console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  /**
   * Show sync status
   */
  supastate
    .command('status')
    .description('Show Supastate sync status and statistics')
    .action(async () => {
      const spinner = ora('Checking status...').start();
      
      try {
        const configManager = new ConfigManager();
        const config = configManager.getConfig();
        
        if (!config.supastate?.enabled) {
          spinner.stop();
          console.log(chalk.yellow('Supastate Status: ') + chalk.red('Disabled'));
          console.log(chalk.gray('Run "camille supastate login" to set up integration'));
          return;
        }

        // Check if server is running
        const apiUrl = 'http://localhost:3456';
        let serverStatus;
        try {
          const response = await fetch(`${apiUrl}/api/supastate/status`);
          if (!response.ok) {
            throw new Error('Server not responding');
          }
          serverStatus = await response.json();
        } catch (error) {
          spinner.stop();
          console.log(chalk.yellow('Supastate Status: ') + chalk.gray('Server not running'));
          console.log(chalk.gray('Start the server with "camille server start" to enable sync'));
          return;
        }
        
        spinner.stop();
        
        console.log(chalk.blue('Supastate Configuration:'));
        console.log(`  Enabled: ${chalk.green('Yes')}`);
        console.log(`  URL: ${chalk.cyan(config.supastate.url || 'Not set')}`);
        console.log(`  Workspace: ${config.supastate.teamId ? chalk.cyan(`Team ${config.supastate.teamId}`) : chalk.cyan('Personal')}`);
        console.log(`  Auto-sync: ${config.supastate.autoSync ? chalk.green('Enabled') : chalk.gray('Disabled')}`);
        
        if (config.supastate.syncInterval) {
          console.log(`  Sync interval: ${chalk.cyan(config.supastate.syncInterval + ' minutes')}`);
        }
        
        console.log(chalk.blue('\nSync Status:'));
        const status = serverStatus as any;
        console.log(`  Service: ${status.enabled ? chalk.green('Active') : chalk.red('Inactive')}`);
        console.log(`  Connection: ${status.connected ? chalk.green('Connected') : chalk.red('Disconnected')}`);
        
        if (status.lastSync) {
          console.log(`  Last sync: ${chalk.cyan(new Date(status.lastSync).toLocaleString())}`);
        }
        
        if (status.chunksCount !== undefined) {
          console.log(`  Synced chunks: ${chalk.cyan(status.chunksCount)}`);
        }
        
        if (status.error) {
          console.log(`  ${chalk.red('Error:')} ${status.error}`);
        }
      } catch (error: unknown) {
        spinner.fail('Failed to get status');
        console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  /**
   * Configure Supastate settings
   */
  supastate
    .command('config <setting> [value]')
    .description('Get or set Supastate configuration')
    .action(async (setting: string, value?: string) => {
      const configManager = new ConfigManager();
      const config = configManager.getConfig();
      
      const validSettings = ['url', 'apiKey', 'teamId', 'autoSync', 'syncInterval'];
      
      if (!validSettings.includes(setting)) {
        console.error(chalk.red(`Invalid setting: ${setting}`));
        console.log(chalk.gray(`Valid settings: ${validSettings.join(', ')}`));
        process.exit(1);
      }
      
      if (value === undefined) {
        // Get current value
        const currentValue = config.supastate?.[setting as keyof typeof config.supastate];
        if (setting === 'apiKey' && currentValue) {
          // Mask API key for security
          console.log(`${setting}: ${chalk.cyan('***' + String(currentValue).slice(-4))}`);
        } else {
          console.log(`${setting}: ${chalk.cyan(currentValue || 'Not set')}`);
        }
      } else {
        // Set new value
        if (!config.supastate) {
          config.supastate = { enabled: false };
        }
        
        // Convert string values to appropriate types
        let parsedValue: any = value;
        if (setting === 'autoSync') {
          parsedValue = value.toLowerCase() === 'true';
        } else if (setting === 'syncInterval') {
          parsedValue = parseInt(value, 10);
          if (isNaN(parsedValue) || parsedValue <= 0) {
            console.error(chalk.red('Sync interval must be a positive number'));
            process.exit(1);
          }
        }
        
        (config.supastate as any)[setting] = parsedValue;
        configManager.updateConfig({ supastate: config.supastate });
        
        console.log(chalk.green(`✅ Updated ${setting}`));
      }
    });

  /**
   * Create a PR review
   */
  supastate
    .command('review <pr-url>')
    .description('Create a multi-agent PR review')
    .option('-s, --style <style>', 'Review style (thorough, quick, security-focused)', 'thorough')
    .action(async (prUrl: string, options) => {
      const spinner = ora('Creating review...').start();
      
      try {
        const configManager = new ConfigManager();
        const config = configManager.getConfig();
        
        if (!config.supastate?.enabled) {
          spinner.fail('Supastate not enabled');
          console.log(chalk.gray('Run "camille supastate enable" first'));
          process.exit(1);
        }

        const client = new SupastateClient();
        const result = await client.createReview(prUrl, {
          style: options.style,
        });

        if (result.success) {
          spinner.succeed('Review created successfully');
          console.log(chalk.gray(`Review ID: ${result.reviewId}`));
          console.log(chalk.cyan(`View in dashboard: ${config.supastate.url}/reviews/${result.reviewId}`));
        } else {
          spinner.fail(`Failed to create review: ${result.error}`);
        }
      } catch (error) {
        spinner.fail('Failed to create review');
        console.error(chalk.red('Error:'), error);
        process.exit(1);
      }
    });

  return supastate;
}