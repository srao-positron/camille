import { exec } from 'child_process';
import * as mysql from 'mysql2';

// Test file with multiple security vulnerabilities

// Command injection vulnerability
export function runCommand(userInput: string) {
  // SECURITY ISSUE: Direct command execution with user input
  exec(`ls -la ${userInput}`, (error, stdout, stderr) => {
    console.log(stdout);
  });
}

// SQL injection vulnerability
export async function deleteUser(db: any, userId: string) {
  // SECURITY ISSUE: Direct string concatenation in SQL
  const query = `DELETE FROM users WHERE id = ${userId}`;
  return await db.execute(query);
}

// Path traversal vulnerability
export function readConfig(filename: string) {
  // SECURITY ISSUE: No validation of filename parameter
  return require(`../../config/${filename}`);
}

// Hardcoded credentials
export const dbConfig = {
  host: 'localhost',
  user: 'admin',
  // SECURITY ISSUE: Hardcoded password
  password: 'super_secret_password_123',
  database: 'production',
  // SECURITY ISSUE: Another hardcoded secret
  apiKey: 'sk-1234567890abcdef'
};