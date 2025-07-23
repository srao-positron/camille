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
    .option('--url <url>', 'Supastate URL', 'https://supastate.ai')
    .action(async (options) => {
      try {
        console.log(chalk.cyan('🔐 Logging in to Supastate...'));
        
        // Create a local server to handle the callback
        const port = 54321;
        const redirectUri = `http://localhost:${port}/callback`;
        
        // Initialize Supabase client
        const supabaseUrl = 'https://zqlfxakbkwssxfynrmnk.supabase.co';
        const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpxbGZ4YWtia3dzc3hmeW5ybW5rIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTM1NzMxMDMsImV4cCI6MjA2OTE0OTEwM30.kPrFPanFFAdhUWpfaaMiHrg5WHR3ywKhXfMjr-5DWKE';
        
        const supabase = createClient(supabaseUrl, supabaseAnonKey);
        
        // Create promise to wait for callback
        let resolveAuth: (value: any) => void;
        const authPromise = new Promise((resolve) => {
          resolveAuth = resolve;
        });
        
        // Create callback server
        const server = createServer(async (req, res) => {
          const url = new URL(req.url!, `http://localhost:${port}`);
          
          if (url.pathname === '/callback') {
            const code = url.searchParams.get('code');
            
            if (code) {
              res.writeHead(200, { 'Content-Type': 'text/html' });
              res.end(`
                <html>
                  <body style="font-family: system-ui; padding: 40px; text-align: center;">
                    <h2>✅ Authentication successful!</h2>
                    <p>You can close this window and return to your terminal.</p>
                    <script>window.close();</script>
                  </body>
                </html>
              `);
              
              // Exchange code for session
              const { data, error } = await supabase.auth.exchangeCodeForSession(code);
              
              if (error) {
                resolveAuth({ error });
              } else {
                resolveAuth({ session: data.session });
              }
              
              server.close();
            } else {
              res.writeHead(400);
              res.end('Missing authorization code');
              resolveAuth({ error: 'Missing authorization code' });
              server.close();
            }
          } else {
            res.writeHead(404);
            res.end('Not found');
          }
        });
        
        server.listen(port);
        
        // Generate auth URL
        const { data: authData, error: authError } = await supabase.auth.signInWithOAuth({
          provider: 'github',
          options: {
            redirectTo: redirectUri,
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
        
        console.log(chalk.green('✅ Authenticated with Supabase'));
        
        // Exchange the session token for an API key
        console.log(chalk.gray('Obtaining API key...'));
        
        const response = await fetch(`${options.url}/api/auth/exchange-token`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${result.session.access_token}`,
            'Content-Type': 'application/json',
          },
        });
        
        if (!response.ok) {
          const error = await response.json();
          throw new Error(`Failed to obtain API key: ${error.error || response.statusText}`);
        }
        
        const apiKeyData = await response.json();
        
        // Save configuration
        const configManager = new ConfigManager();
        const config = configManager.getConfig();
        
        if (apiKeyData.action === 'created') {
          // New API key created
          configManager.updateConfig({
            supastate: {
              ...config.supastate,
              enabled: true,
              url: options.url,
              apiKey: apiKeyData.apiKey,
              userId: apiKeyData.userId,
              email: apiKeyData.email,
            },
          });
          
          console.log(chalk.green('✅ API key created and saved'));
          console.log(chalk.gray(`Logged in as: ${apiKeyData.email}`));
        } else {
          // Existing API key
          console.log(chalk.yellow('⚠️  You already have an API key for Camille'));
          console.log(chalk.gray('To generate a new key, please revoke the existing one in Supastate dashboard'));
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