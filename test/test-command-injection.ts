import { exec } from 'child_process';
import { Request, Response } from 'express';

// Test file with command injection vulnerability
export function executeCommand(req: Request, res: Response) {
  const filename = req.query.file as string;
  
  // CRITICAL SECURITY ISSUE: Command injection vulnerability
  exec(`ls -la /tmp/${filename}`, (error, stdout, stderr) => {
    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }
    res.json({ output: stdout });
  });
}

// Another security issue: hardcoded credentials
const DB_PASSWORD = 'super_secret_password_123';
const API_KEY = 'sk-prod-1234567890abcdef';
const AWS_SECRET = 'aws-secret-key-production';