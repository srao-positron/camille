import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import open from 'open';
import { ConfigManager } from '../config.js';
import fetch from 'node-fetch';
import { createServer } from 'http';
import { URL } from 'url';

export function createSupabaseLoginCommand(): Command {
  const command = new Command('login');
  
  command
    .description('Login to Supastate and obtain API key')
    .action(async () => {
      try {
        console.log(chalk.cyan('🔐 Logging in to Supastate...'));
        
        // Create a local server to handle the callback
        const port = 8899; // Use a different port to avoid conflicts
        const redirectUri = `http://localhost:${port}/callback`;
        
        // Create promise to wait for callback
        let resolveAuth: (value: any) => void;
        const authPromise = new Promise<any>((resolve) => {
          resolveAuth = resolve;
        });
        
        // Create callback server
        const server = createServer(async (req, res) => {
          const url = new URL(req.url!, `http://localhost:${port}`);
          
          if (url.pathname === '/cli-callback' && req.method === 'POST') {
            // Handle API key callback from www.supastate.ai
            console.log(chalk.gray('[DEBUG] Received POST to /cli-callback'));
            let body = '';
            req.on('data', chunk => {
              body += chunk.toString();
            });
            req.on('end', () => {
              try {
                console.log(chalk.gray('[DEBUG] Received body:', body));
                const data = JSON.parse(body);
                res.writeHead(200, { 
                  'Content-Type': 'application/json',
                  'Access-Control-Allow-Origin': '*'
                });
                res.end(JSON.stringify({ success: true }));
                console.log(chalk.gray('[DEBUG] Successfully received API key data'));
                resolveAuth({ apiKeyData: data });
                server.close();
              } catch (err) {
                console.error(chalk.red('[DEBUG] Error parsing callback data:', err));
                res.writeHead(400);
                res.end('Invalid data');
                resolveAuth({ error: 'Invalid callback data' });
                server.close();
              }
            });
          } else if (url.pathname === '/cli-callback' && req.method === 'OPTIONS') {
            // Handle CORS preflight
            res.writeHead(200, {
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Allow-Methods': 'POST, OPTIONS',
              'Access-Control-Allow-Headers': 'Content-Type',
            });
            res.end();
          } else {
            res.writeHead(404);
            res.end('Not found');
          }
        });
        
        server.listen(port);
        
        // Use server-side OAuth flow
        console.log(chalk.gray(`[DEBUG] Opening browser for authentication...`));
        
        // Open browser directly to the cli-init endpoint
        // This will set up the OAuth flow with our CLI state embedded
        const webAppUrl = 'https://www.supastate.ai';
        const authInitUrl = `${webAppUrl}/api/auth/cli-init?port=${port}`;
        
        console.log(chalk.gray(`[DEBUG] Auth URL: ${authInitUrl}`));
        await open(authInitUrl);
        
        console.log(chalk.gray(`Waiting for authentication...`));
        console.log(chalk.gray(`If the browser doesn't open, visit: ${authInitUrl}`));
        
        // Wait for authentication
        const result = await authPromise;
        
        if (result.error) {
          throw new Error(`Authentication failed: ${result.error}`);
        }
        
        // Check if we got JWT data directly from the callback
        if (result.apiKeyData) {
          console.log(chalk.green('✅ Authenticated with Supabase'));
          console.log(chalk.gray('Received authentication tokens...'));
          
          // Save configuration
          const configManager = new ConfigManager();
          const config = configManager.getConfig();
          
          configManager.updateConfig({
            supastate: {
              ...config.supastate,
              enabled: true,
              url: 'https://service.supastate.ai', // Always use the API URL for edge functions
              accessToken: result.apiKeyData.accessToken,
              refreshToken: result.apiKeyData.refreshToken,
              expiresAt: result.apiKeyData.expiresAt,
              userId: result.apiKeyData.userId,
              email: result.apiKeyData.email,
            },
          });
          
          console.log(chalk.green('✅ Authentication successful'));
          console.log(chalk.gray(`Logged in as: ${result.apiKeyData.email}`));
          console.log(chalk.gray(`Session expires: ${new Date(result.apiKeyData.expiresAt * 1000).toLocaleString()}`));
        } else {
          // This shouldn't happen with the new flow
          throw new Error('No authentication tokens received from authentication flow');
        }
        
        console.log(chalk.cyan('\n🚀 Supastate integration is ready!'));
        console.log(chalk.gray('Your memories and code will now sync to Supastate for enhanced search'));
        
      } catch (error) {
        console.error(chalk.red('Login failed:'), error);
        process.exit(1);
      }
    });
  
  return command;
}