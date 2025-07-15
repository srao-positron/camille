/**
 * Code parser interface for extracting code structure and dependencies
 */

import { CodeNode, CodeEdge } from '../memory/databases/graph-db.js';

export interface ParsedFile {
  file: string;
  nodes: CodeNode[];
  edges: CodeEdge[];
  imports: ImportStatement[];
  exports: ExportStatement[];
}

export interface ImportStatement {
  source: string;  // Module being imported from
  imports: string[];  // What's being imported
  line: number;
  isDefault?: boolean;
  isNamespace?: boolean;
}

export interface ExportStatement {
  name: string;
  type: 'function' | 'class' | 'interface' | 'variable' | 'type';
  line: number;
  isDefault?: boolean;
}

export interface FunctionCall {
  functionName: string;
  line: number;
  column: number;
  arguments?: string[];
}

export interface CodeParser {
  /**
   * Parse a file and extract code structure
   * @param filePath Absolute path to the file
   * @param content File content
   * @returns Parsed code structure
   */
  parse(filePath: string, content: string): Promise<ParsedFile>;

  /**
   * Check if this parser can handle the given file
   * @param filePath File path
   * @returns true if parser can handle the file
   */
  canParse(filePath: string): boolean;

  /**
   * Get supported file extensions
   * @returns Array of supported extensions (e.g., ['.ts', '.js'])
   */
  getSupportedExtensions(): string[];
}

/**
 * Factory for creating appropriate parser for a file
 */
export class ParserFactory {
  private parsers: CodeParser[] = [];

  /**
   * Register a parser
   */
  registerParser(parser: CodeParser): void {
    this.parsers.push(parser);
  }

  /**
   * Get appropriate parser for a file
   * @param filePath File path
   * @returns Parser instance or null if no parser available
   */
  getParser(filePath: string): CodeParser | null {
    return this.parsers.find(parser => parser.canParse(filePath)) || null;
  }

  /**
   * Check if any parser can handle the file
   * @param filePath File path
   * @returns true if file can be parsed
   */
  canParse(filePath: string): boolean {
    return this.parsers.some(parser => parser.canParse(filePath));
  }
}