import { Request, Response } from 'express';
import * as fs from 'fs';

// Test file with intentional security vulnerability
export function handleFileRead(req: Request, res: Response) {
  // SECURITY ISSUE: Path traversal vulnerability
  const filename = req.params.filename;
  const filepath = `/var/data/${filename}`;
  
  // Direct file read without validation
  const content = fs.readFileSync(filepath, 'utf-8');
  res.send(content);
}

// Another security issue: SQL injection
export function searchUsers(db: any, searchTerm: string) {
  const query = `SELECT * FROM users WHERE name = '${searchTerm}'`;
  return db.execute(query);
}