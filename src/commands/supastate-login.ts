/**
 * Supastate login command for authenticating Camille with Supastate
 */

import { Command } from 'commander';
import chalk from 'chalk';
import open from 'open';
import express from 'express';
import { ConfigManager } from '../config.js';
import { logger } from '../logger.js';
import crypto from 'crypto';
import http from 'http';

export function createSupastateLoginCommand(): Command {
  const command = new Command('login');
  
  command
    .description('Authenticate with Supastate to enable sync features')
    .option('--url <url>', 'Supastate URL', 'https://supastate.ai')
    .option('--no-browser', 'Print auth URL instead of opening browser')
    .action(async (options) => {
      const config = new ConfigManager();
      
      try {
        console.log(chalk.blue('🔐 Authenticating with Supastate...'));
        
        // Generate a secure state parameter
        const state = crypto.randomBytes(32).toString('hex');
        
        // Create a local callback server
        const app = express();
        let server: http.Server | undefined;
        
        const authPromise = new Promise<{ apiKey: string; userId: string }>((resolve, reject) => {
          // Callback endpoint
          app.get('/auth/callback', async (req, res) => {
            try {
              const { state: returnedState, api_key, user_id, error } = req.query;
              
              if (error) {
                res.send(`
                  <html>
                    <body>
                      <h1>Authentication Failed</h1>
                      <p>${error}</p>
                      <p>You can close this window and try again.</p>
                    </body>
                  </html>
                `);
                reject(new Error(String(error)));
                return;
              }
              
              // Verify state parameter
              if (returnedState !== state) {
                res.send(`
                  <html>
                    <body>
                      <h1>Invalid State</h1>
                      <p>Authentication failed due to invalid state parameter.</p>
                    </body>
                  </html>
                `);
                reject(new Error('Invalid state parameter'));
                return;
              }
              
              if (!api_key || !user_id) {
                res.send(`
                  <html>
                    <body>
                      <h1>Missing Credentials</h1>
                      <p>Authentication failed - missing API key or user ID.</p>
                    </body>
                  </html>
                `);
                reject(new Error('Missing API key or user ID'));
                return;
              }
              
              // Success response
              res.send(`
                <html>
                  <head>
                    <style>
                      body {
                        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        height: 100vh;
                        margin: 0;
                        background: #f5f5f5;
                      }
                      .container {
                        text-align: center;
                        background: white;
                        padding: 40px;
                        border-radius: 8px;
                        box-shadow: 0 2px 10px rgba(0,0,0,0.1);
                      }
                      h1 { color: #22c55e; }
                      p { color: #666; margin: 20px 0; }
                    </style>
                  </head>
                  <body>
                    <div class="container">
                      <h1>✅ Authentication Successful!</h1>
                      <p>Camille is now connected to Supastate.</p>
                      <p>You can close this window and return to your terminal.</p>
                    </div>
                  </body>
                </html>
              `);
              
              resolve({ 
                apiKey: String(api_key), 
                userId: String(user_id) 
              });
            } catch (error) {
              logger.error('Callback error:', error);
              res.status(500).send('Internal error');
              reject(error);
            }
          });
          
          // Start the server
          const port = 7823; // Random port for Camille auth
          server = app.listen(port, () => {
            console.log(chalk.gray(`Callback server listening on port ${port}`));
          });
        });
        
        // Build auth URL - using the page, not the API route
        const authUrl = new URL(`${options.url}/auth/cli`);
        authUrl.searchParams.set('client', 'camille');
        authUrl.searchParams.set('state', state);
        authUrl.searchParams.set('callback', `http://localhost:7823/auth/callback`);
        
        // Open browser or print URL
        if (options.browser) {
          console.log(chalk.gray('Opening browser for authentication...'));
          await open(authUrl.toString());
        } else {
          console.log(chalk.yellow('\n🔗 Please open this URL in your browser:'));
          console.log(chalk.blue(authUrl.toString()));
        }
        
        console.log(chalk.gray('\nWaiting for authentication...'));
        
        // Wait for auth with timeout
        const timeout = setTimeout(() => {
          server?.close();
          throw new Error('Authentication timeout (5 minutes)');
        }, 5 * 60 * 1000);
        
        try {
          const { apiKey, userId } = await authPromise;
          clearTimeout(timeout);
          server?.close();
          
          console.log(chalk.green('✅ Authentication successful!'));
          
          // Update config with personal workspace
          const currentConfig = config.getConfig();
          config.updateConfig({
            ...currentConfig,
            supastate: {
              ...currentConfig.supastate,
              enabled: true,
              url: options.url,
              apiKey: apiKey,
              teamId: undefined, // Personal workspace, no team
              userId: userId,
              autoSync: currentConfig.supastate?.autoSync ?? true,
              syncInterval: currentConfig.supastate?.syncInterval ?? 30,
              serverSideProcessing: true // Enable new architecture by default
            }
          });
          
          console.log(chalk.gray(`\n📝 Configuration saved to ${config.getConfigPath()}`));
          console.log(chalk.blue('\n🚀 Supastate sync is now enabled!'));
          console.log(chalk.gray('Your Camille memories will be automatically synced to your personal workspace.'));
          console.log(chalk.gray('\nUse "camille supastate sync" to manually sync, or'));
          console.log(chalk.gray('"camille supastate status" to check sync status.'));
          
        } catch (error) {
          clearTimeout(timeout);
          server?.close();
          throw error;
        }
        
      } catch (error) {
        console.error(chalk.red('❌ Authentication failed:'), error instanceof Error ? error.message : error);
        process.exit(1);
      }
    });
  
  return command;
}