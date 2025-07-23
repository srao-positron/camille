import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import open from 'open';
import { createClient } from '@supabase/supabase-js';
import { ConfigManager } from '../config.js';
import fetch from 'node-fetch';
import { createServer } from 'http';
import { URL } from 'url';

export function createSupabaseLoginCommand(): Command {
  const command = new Command('login');
  
  command
    .description('Login to Supastate and obtain API key')
    .option('--url <url>', 'Supastate URL', 'https://www.supastate.ai')
    .action(async (options) => {
      try {
        console.log(chalk.cyan('🔐 Logging in to Supastate...'));
        
        // Create a local server to handle the callback
        const port = 8899; // Use a different port to avoid conflicts
        const redirectUri = `http://localhost:${port}/callback`;
        
        // Initialize Supabase client - use production URL
        const supabaseUrl = 'https://zqlfxakbkwssxfynrmnk.supabase.co';
        const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpxbGZ4YWtia3dzc3hmeW5ybW5rIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTM1NzMxMDMsImV4cCI6MjA2OTE0OTEwM30.kPrFPanFFAdhUWpfaaMiHrg5WHR3ywKhXfMjr-5DWKE';
        
        const supabase = createClient(supabaseUrl, supabaseAnonKey);
        
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
            let body = '';
            req.on('data', chunk => {
              body += chunk.toString();
            });
            req.on('end', () => {
              try {
                const data = JSON.parse(body);
                res.writeHead(200, { 
                  'Content-Type': 'application/json',
                  'Access-Control-Allow-Origin': '*'
                });
                res.end(JSON.stringify({ success: true }));
                resolveAuth({ apiKeyData: data });
                server.close();
              } catch (err) {
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
        
        // Generate auth URL with redirect to service.supastate.ai
        const { data: authData, error: authError } = await supabase.auth.signInWithOAuth({
          provider: 'github',
          options: {
            redirectTo: `${options.url}/auth/cli/callback?port=${port}`,
            scopes: 'read:user user:email',
          },
        });
        
        if (authError || !authData.url) {
          throw new Error('Failed to generate authentication URL');
        }
        
        console.log(chalk.gray(`Opening browser for authentication...`));
        await open(authData.url);
        
        console.log(chalk.gray(`Waiting for authentication...`));
        console.log(chalk.gray(`If the browser doesn't open, visit: ${authData.url}`));
        
        // Wait for authentication
        const result = await authPromise;
        
        if (result.error) {
          throw new Error(`Authentication failed: ${result.error}`);
        }
        
        // Check if we got API key data directly from the callback
        if (result.apiKeyData) {
          console.log(chalk.green('✅ Authenticated with Supabase'));
          console.log(chalk.gray('Received API key from Supastate...'));
          
          // Save configuration
          const configManager = new ConfigManager();
          const config = configManager.getConfig();
          
          configManager.updateConfig({
            supastate: {
              ...config.supastate,
              enabled: true,
              url: options.url,
              apiKey: result.apiKeyData.apiKey,
              userId: result.apiKeyData.userId,
              email: result.apiKeyData.email,
            },
          });
          
          console.log(chalk.green('✅ API key created and saved'));
          console.log(chalk.gray(`Logged in as: ${result.apiKeyData.email}`));
        } else {
          // This shouldn't happen with the new flow
          throw new Error('No API key received from authentication flow');
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