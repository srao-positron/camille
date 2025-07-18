/**
 * Embeddings management for code search functionality
 * Handles in-memory storage with optional disk caching
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { glob } from 'glob';
import { ConfigManager } from './config';
import { logger } from './logger';

/**
 * Represents an embedded file in the index
 */
export interface EmbeddedFile {
  path: string;
  embedding: number[];
  content: string;
  hash: string;
  lastModified: number;
  summary?: string;
}

/**
 * Similarity search result
 */
export interface SearchResult {
  path: string;
  similarity: number;
  content: string;
  summary?: string;
  lineMatches?: LineMatch[];
}

/**
 * Line match information for search results
 */
export interface LineMatch {
  lineNumber: number;
  line: string;
  snippet: string;
  matchStart?: number;
  matchEnd?: number;
}

/**
 * Embeddings index manager
 */
export class EmbeddingsIndex {
  private index: Map<string, EmbeddedFile> = new Map();
  private cacheDir: string;
  private cacheToDisk: boolean;
  private isReady: boolean = false;

  constructor(private configManager: ConfigManager) {
    const config = configManager.getConfig();
    this.cacheToDisk = config.cacheToDisk;
    // Use the standard .camille directory for cache
    const homeDir = process.env.CAMILLE_CONFIG_DIR || path.join(require('os').homedir(), '.camille');
    this.cacheDir = path.join(homeDir, 'cache');
    
    if (this.cacheToDisk) {
      this.ensureCacheDir();
      this.loadCache();
    }
  }

  /**
   * Ensures cache directory exists
   */
  private ensureCacheDir(): void {
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  /**
   * Loads cached embeddings from disk
   */
  private loadCache(): void {
    const cacheFile = path.join(this.cacheDir, 'index.json');
    if (fs.existsSync(cacheFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        let loadedCount = 0;
        for (const [path, embedding] of Object.entries(data)) {
          this.index.set(path, embedding as EmbeddedFile);
          loadedCount++;
        }
        console.log(`Loaded ${loadedCount} embeddings from cache`);
      } catch (error) {
        console.error('Failed to load embeddings cache:', error);
      }
    } else {
      console.log(`No cache file found at ${cacheFile}`);
    }
  }

  /**
   * Saves embeddings to disk cache
   */
  private saveCache(): void {
    if (!this.cacheToDisk) return;
    
    const cacheFile = path.join(this.cacheDir, 'index.json');
    const data: Record<string, EmbeddedFile> = {};
    
    for (const [path, embedding] of this.index.entries()) {
      data[path] = embedding;
    }
    
    fs.writeFileSync(cacheFile, JSON.stringify(data, null, 2));
  }

  /**
   * Adds or updates a file embedding
   */
  public addEmbedding(filePath: string, embedding: number[], content: string, summary?: string): void {
    const stats = fs.statSync(filePath);
    const hash = this.computeFileHash(content);
    
    this.index.set(filePath, {
      path: filePath,
      embedding,
      content,
      hash,
      lastModified: stats.mtimeMs,
      summary
    });
    
    if (this.cacheToDisk) {
      this.saveCache();
    }
  }

  /**
   * Removes a file from the index
   */
  public removeFile(filePath: string): void {
    this.index.delete(filePath);
    
    if (this.cacheToDisk) {
      this.saveCache();
    }
  }

  /**
   * Checks if a file needs re-indexing
   */
  public needsReindex(filePath: string): boolean {
    const existing = this.index.get(filePath);
    if (!existing) {
      console.log(`File not in cache: ${filePath}`);
      return true;
    }
    
    try {
      const stats = fs.statSync(filePath);
      const content = fs.readFileSync(filePath, 'utf8');
      const hash = this.computeFileHash(content);
      
      const needsUpdate = existing.hash !== hash || existing.lastModified !== stats.mtimeMs;
      if (!needsUpdate) {
        console.log(`Using cache for: ${filePath}`);
      }
      return needsUpdate;
    } catch {
      return true;
    }
  }

  /**
   * Searches for similar files using cosine similarity
   */
  public search(queryEmbedding: number[], limit: number = 10, query?: string): SearchResult[] {
    const results: SearchResult[] = [];
    logger.info('EmbeddingsIndex.search called', { 
      limit, 
      hasQuery: !!query,
      query,
      indexSize: this.index.size 
    });
    
    for (const file of this.index.values()) {
      const similarity = this.cosineSimilarity(queryEmbedding, file.embedding);
      const result: SearchResult = {
        path: file.path,
        similarity,
        content: file.content,
        summary: file.summary
      };
      
      // If query is provided, extract relevant line matches
      if (query) {
        const lineMatches = this.extractLineMatches(file.content, query);
        logger.debug('Line matches extracted', {
          file: file.path,
          query,
          matchCount: lineMatches.length,
          matches: lineMatches.slice(0, 2) // Log first 2 matches
        });
        result.lineMatches = lineMatches;
      }
      
      results.push(result);
    }
    
    // Sort by similarity (descending) and limit results
    return results
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
  }

  /**
   * Gets all indexed files
   */
  public getIndexedFiles(): string[] {
    return Array.from(this.index.keys());
  }

  /**
   * Gets the total number of indexed files
   */
  public getIndexSize(): number {
    return this.index.size;
  }

  /**
   * Checks if the index is ready for queries
   */
  public isIndexReady(): boolean {
    return this.isReady;
  }

  /**
   * Sets the index ready state
   */
  public setReady(ready: boolean): void {
    this.isReady = ready;
  }

  /**
   * Clears the entire index
   */
  public clear(): void {
    this.index.clear();
    if (this.cacheToDisk) {
      this.saveCache();
    }
  }

  /**
   * Computes SHA256 hash of file content
   */
  private computeFileHash(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  /**
   * Calculates cosine similarity between two vectors
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      throw new Error('Vectors must have the same length');
    }
    
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    
    normA = Math.sqrt(normA);
    normB = Math.sqrt(normB);
    
    if (normA === 0 || normB === 0) {
      return 0;
    }
    
    return dotProduct / (normA * normB);
  }

  /**
   * Extracts line matches from content based on semantic relevance
   */
  private extractLineMatches(content: string, query: string): LineMatch[] {
    const lines = content.split('\n');
    const matches: LineMatch[] = [];
    const queryLower = query.toLowerCase();
    const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2);
    
    logger.debug('extractLineMatches called', {
      contentLength: content.length,
      lineCount: lines.length,
      query,
      queryWords
    });
    
    // Score each line for relevance
    const lineScores: { line: string; lineNumber: number; score: number }[] = [];
    
    lines.forEach((line, index) => {
      const lineLower = line.toLowerCase();
      let score = 0;
      
      // Check for exact query match
      if (lineLower.includes(queryLower)) {
        score += 10;
      }
      
      // Check for individual word matches
      queryWords.forEach(word => {
        if (lineLower.includes(word)) {
          score += 3;
        }
      });
      
      // Boost scores for certain patterns
      if (line.match(/^\s*(function|class|interface|type|const|let|var|def|public|private|protected)\s+/)) {
        score += 2;
      }
      
      if (score > 0) {
        lineScores.push({
          line: line.trim(),
          lineNumber: index + 1,
          score
        });
      }
    });
    
    // Sort by score and take top 5 most relevant lines
    const topLines = lineScores
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    
    logger.debug('Line scoring complete', {
      totalScoredLines: lineScores.length,
      topLinesCount: topLines.length,
      topScores: topLines.map(l => ({ lineNum: l.lineNumber, score: l.score }))
    });
    
    // For each top line, include context
    topLines.forEach(({ line, lineNumber }) => {
      const startLine = Math.max(0, lineNumber - 3);
      const endLine = Math.min(lines.length, lineNumber + 2);
      
      const snippet = lines
        .slice(startLine, endLine)
        .map((l, i) => {
          const currentLineNum = startLine + i + 1;
          const marker = currentLineNum === lineNumber ? '>' : ' ';
          return `${marker} ${currentLineNum.toString().padStart(4)}: ${l}`;
        })
        .join('\n');
      
      matches.push({
        lineNumber,
        line,
        snippet
      });
    });
    
    logger.debug('Final line matches', {
      matchCount: matches.length,
      matches: matches.map(m => ({ lineNum: m.lineNumber, line: m.line.substring(0, 50) }))
    });
    
    return matches;
  }
}

/**
 * File filter for indexing
 */
export class FileFilter {
  private ignorePatterns: string[];

  constructor(ignorePatterns: string[]) {
    this.ignorePatterns = ignorePatterns;
  }

  /**
   * Checks if a file should be indexed
   */
  public shouldIndex(filePath: string): boolean {
    // Skip non-text files
    const textExtensions = [
      '.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.c', '.cpp', '.h', '.hpp',
      '.cs', '.go', '.rs', '.rb', '.php', '.swift', '.kt', '.scala', '.r',
      '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd',
      '.json', '.xml', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
      '.md', '.txt', '.rst', '.tex', '.html', '.css', '.scss', '.sass', '.less',
      '.sql', '.graphql', '.proto', '.dockerfile', '.makefile', '.cmake'
    ];
    
    const ext = path.extname(filePath).toLowerCase();
    if (ext && !textExtensions.includes(ext)) {
      return false;
    }
    
    // Check against ignore patterns
    for (const pattern of this.ignorePatterns) {
      if (this.matchesPattern(filePath, pattern)) {
        return false;
      }
    }
    
    return true;
  }

  /**
   * Simple pattern matching (supports * and **)
   */
  private matchesPattern(filePath: string, pattern: string): boolean {
    // Normalize paths for comparison
    const normalizedPath = filePath.replace(/\\/g, '/');
    
    // Convert glob pattern to regex
    const regexPattern = pattern
      .replace(/\\/g, '/')
      .replace(/\*\*/g, '___DOUBLE_STAR___')
      .replace(/\*/g, '[^/]*')
      .replace(/___DOUBLE_STAR___/g, '.*')
      .replace(/\?/g, '.')
      .replace(/\./g, '\\.');
    
    // Match pattern anywhere in the path
    const regex = new RegExp(regexPattern);
    return regex.test(normalizedPath);
  }
}