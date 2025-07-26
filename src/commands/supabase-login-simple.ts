import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { ConfigManager } from '../config.js';
import fetch from 'node-fetch';

export function createSupabaseLoginSimpleCommand(): Command {
  const command = new Command('login-simple');
  
  command
    .description('Login to Supastate with email and password')
    .option('--url <url>', 'Supastate URL', 'https://www.supastate.ai')
    .option('-e, --email <email>', 'Email address')
    .action(async (options) => {
      try {
        console.log(chalk.cyan('🔐 Logging in to Supastate...'));
        
        // Prompt for credentials
        const answers = await inquirer.prompt([
          {
            type: 'input',
            name: 'email',
            message: 'Email:',
            when: !options.email,
            validate: (input) => {
              const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
              return emailRegex.test(input) || 'Please enter a valid email address';
            },
          },
          {
            type: 'password',
            name: 'password',
            message: 'Password:',
            mask: '*',
            validate: (input) => input.length > 0 || 'Password is required',
          },
        ]);
        
        const email = options.email || answers.email;
        const password = answers.password;
        
        // Call login API
        console.log(chalk.gray('Authenticating...'));
        
        const response = await fetch(`${options.url}/api/auth/login`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ email, password }),
        });
        
        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.error || 'Login failed');
        }
        
        const data = await response.json();
        
        // Save configuration
        const configManager = new ConfigManager();
        const config = configManager.getConfig();
        
        if (data.accessToken && data.refreshToken) {
          // JWT tokens received
          configManager.updateConfig({
            supastate: {
              ...config.supastate,
              enabled: true,
              url: options.url,
              accessToken: data.accessToken,
              refreshToken: data.refreshToken,
              expiresAt: data.expiresAt,
              userId: data.userId,
              email: data.email,
            },
          });
          
          console.log(chalk.green('✅ Authentication successful'));
          console.log(chalk.gray(`Logged in as: ${data.email}`));
          console.log(chalk.gray(`Session expires: ${new Date(data.expiresAt * 1000).toLocaleString()}`));
        } else {
          throw new Error('No authentication tokens received');
        }
        
        console.log(chalk.cyan('\n🚀 Supastate integration is ready!'));
        console.log(chalk.gray('Your memories and code will now sync to Supastate for enhanced search'));
        
      } catch (error) {
        console.error(chalk.red('Login failed:'), error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });
  
  return command;
}