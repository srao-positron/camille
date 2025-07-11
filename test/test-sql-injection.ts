import { Request, Response } from 'express';

// Test file with SQL injection vulnerability
export async function searchUsers(req: Request, res: Response, db: any) {
  const searchTerm = req.query.search as string;
  
  // CRITICAL SECURITY ISSUE: SQL injection vulnerability
  const query = `SELECT * FROM users WHERE name LIKE '%${searchTerm}%'`;
  
  try {
    const results = await db.execute(query);
    res.json({ users: results });
  } catch (error) {
    res.status(500).json({ error: 'Database error' });
  }
}