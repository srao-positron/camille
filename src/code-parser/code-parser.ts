/**
 * Main code parser manager that coordinates different language parsers
 */

import { ParserFactory, CodeParser, ParsedFile } from './parser-interface.js';
import { TypeScriptParser } from './typescript-parser.js';
import { logger } from '../logger.js';

export class CodeParserManager implements CodeParser {
  private factory: ParserFactory;

  constructor() {
    this.factory = new ParserFactory();
    this.registerDefaultParsers();
  }

  /**
   * Register default parsers for common languages
   */
  private registerDefaultParsers(): void {
    this.factory.registerParser(new TypeScriptParser());
    // Future parsers can be added here:
    // this.factory.registerParser(new PythonParser());
    // this.factory.registerParser(new JavaParser());
  }

  /**
   * Parse a file and extract code structure
   * @param filePath Absolute path to the file
   * @param content File content
   * @returns Parsed code structure or null if no parser available
   */
  async parseFile(filePath: string, content: string): Promise<ParsedFile | null> {
    const parser = this.factory.getParser(filePath);
    
    if (!parser) {
      logger.debug('No parser available for file', { filePath });
      return null;
    }

    try {
      const result = await parser.parse(filePath, content);
      logger.debug('File parsed successfully', { 
        filePath, 
        nodeCount: result.nodes.length,
        edgeCount: result.edges.length,
        importCount: result.imports.length
      });
      return result;
    } catch (error) {
      logger.error('Failed to parse file', { filePath, error });
      return null;
    }
  }

  /**
   * Check if a file can be parsed
   * @param filePath File path
   * @returns true if file can be parsed
   */
  canParse(filePath: string): boolean {
    return this.factory.canParse(filePath);
  }

  /**
   * Get list of all supported file extensions
   * @returns Array of supported extensions
   */
  getSupportedExtensions(): string[] {
    // This is a bit tricky since we need to aggregate from all parsers
    // For now, we'll return TypeScript extensions
    return ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
  }

  /**
   * Register a custom parser
   * @param parser Parser instance
   */
  registerParser(parser: CodeParser): void {
    this.factory.registerParser(parser);
  }

  /**
   * Parse method to implement CodeParser interface
   */
  async parse(filePath: string, content: string): Promise<ParsedFile> {
    const result = await this.parseFile(filePath, content);
    if (!result) {
      // Return empty ParsedFile if no parser available
      return {
        file: filePath,
        nodes: [],
        edges: [],
        imports: [],
        exports: []
      };
    }
    return result;
  }
}

// Export singleton instance
export const codeParser = new CodeParserManager();