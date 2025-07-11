// Test file to check if Camille hooks are working
export function vulnerableFunction(userInput: string) {
  // SECURITY ISSUE: eval() with user input
  return eval(userInput);
}

// SQL injection vulnerability
export async function unsafeQuery(db: any, id: string) {
  const query = `SELECT * FROM users WHERE id = '${id}'`;
  return db.execute(query);
}

// Another security issue: command injection
export function runCommand(filename: string) {
  const { exec } = require('child_process');
  // SECURITY ISSUE: Command injection
  exec(`cat /etc/passwd | grep ${filename}`, (err, stdout) => {
    console.log(stdout);
  });
}

// SECURITY ISSUE: Hardcoded API credentials
export const API_CONFIG = {
  apiKey: 'sk-prod-abc123def456',
  apiSecret: 'super_secret_production_key',
  databasePassword: 'admin123',
  // MORE SECURITY ISSUES: Additional hardcoded secrets
  stripeKey: 'sk_live_1234567890',
  twilioAuth: 'auth_token_production'
};