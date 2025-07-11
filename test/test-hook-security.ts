import { exec } from 'child_process';

// Test file to check if hooks are working with security issues

export function dangerousFunction(userInput: string) {
  // CRITICAL SECURITY ISSUE: Command injection vulnerability
  exec(`ls -la ${userInput}`, (error, stdout) => {
    console.log(stdout);
  });
}

// SECURITY ISSUE: Hardcoded database credentials
const DB_CONFIG = {
  host: 'prod.database.com',
  username: 'admin',
  password: 'SuperSecret123!',
  database: 'production_db',
  // MORE SECURITY ISSUES
  apiKey: 'sk_live_dangerous_key'
};