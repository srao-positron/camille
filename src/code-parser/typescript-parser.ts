/**
 * TypeScript/JavaScript parser using TypeScript compiler API
 */

import * as ts from 'typescript';
import * as path from 'path';
import { CodeParser, ParsedFile, ImportStatement, ExportStatement, FunctionCall } from './parser-interface.js';
import { CodeNode, CodeEdge } from '../memory/databases/graph-db.js';
import { logger } from '../logger.js';

export class TypeScriptParser implements CodeParser {
  private static readonly SUPPORTED_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

  canParse(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return TypeScriptParser.SUPPORTED_EXTENSIONS.includes(ext);
  }

  getSupportedExtensions(): string[] {
    return [...TypeScriptParser.SUPPORTED_EXTENSIONS];
  }

  async parse(filePath: string, content: string): Promise<ParsedFile> {
    try {
      // Create TypeScript source file
      const sourceFile = ts.createSourceFile(
        filePath,
        content,
        ts.ScriptTarget.Latest,
        true
      );

      const result: ParsedFile = {
        file: filePath,
        nodes: [],
        edges: [],
        imports: [],
        exports: []
      };

      // Extract all the information in one pass
      this.extractFromSourceFile(sourceFile, result);

      return result;
    } catch (error) {
      logger.error('Failed to parse TypeScript file', { filePath, error });
      return {
        file: filePath,
        nodes: [],
        edges: [],
        imports: [],
        exports: []
      };
    }
  }

  private extractFromSourceFile(sourceFile: ts.SourceFile, result: ParsedFile): void {
    const visit = (node: ts.Node) => {
      switch (node.kind) {
        case ts.SyntaxKind.ImportDeclaration:
          this.extractImport(node as ts.ImportDeclaration, sourceFile, result);
          break;
        case ts.SyntaxKind.ExportDeclaration:
        case ts.SyntaxKind.ExportAssignment:
          this.extractExport(node, sourceFile, result);
          break;
        case ts.SyntaxKind.FunctionDeclaration:
          this.extractFunction(node as ts.FunctionDeclaration, sourceFile, result);
          break;
        case ts.SyntaxKind.MethodDeclaration:
          this.extractMethod(node as ts.MethodDeclaration, sourceFile, result);
          break;
        case ts.SyntaxKind.ClassDeclaration:
          this.extractClass(node as ts.ClassDeclaration, sourceFile, result);
          break;
        case ts.SyntaxKind.InterfaceDeclaration:
          this.extractInterface(node as ts.InterfaceDeclaration, sourceFile, result);
          break;
        case ts.SyntaxKind.VariableDeclaration:
          this.extractVariable(node as ts.VariableDeclaration, sourceFile, result);
          break;
        case ts.SyntaxKind.CallExpression:
          this.extractFunctionCall(node as ts.CallExpression, sourceFile, result);
          break;
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  private extractImport(node: ts.ImportDeclaration, sourceFile: ts.SourceFile, result: ParsedFile): void {
    const moduleSpecifier = node.moduleSpecifier as ts.StringLiteral;
    const source = moduleSpecifier.text;
    const line = this.getLineNumber(node, sourceFile);
    
    const imports: string[] = [];
    let isDefault = false;
    let isNamespace = false;

    if (node.importClause) {
      // Default import
      if (node.importClause.name) {
        imports.push(node.importClause.name.text);
        isDefault = true;
      }

      // Named imports
      if (node.importClause.namedBindings) {
        if (ts.isNamespaceImport(node.importClause.namedBindings)) {
          imports.push(node.importClause.namedBindings.name.text);
          isNamespace = true;
        } else if (ts.isNamedImports(node.importClause.namedBindings)) {
          node.importClause.namedBindings.elements.forEach(element => {
            imports.push(element.name.text);
          });
        }
      }
    }

    result.imports.push({
      source,
      imports,
      line,
      isDefault,
      isNamespace
    });
  }

  private extractExport(node: ts.Node, sourceFile: ts.SourceFile, result: ParsedFile): void {
    const line = this.getLineNumber(node, sourceFile);

    if (ts.isExportDeclaration(node)) {
      // Handle export { ... } from '...'
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        node.exportClause.elements.forEach(element => {
          result.exports.push({
            name: element.name.text,
            type: 'variable', // We don't know the exact type from export declaration
            line
          });
        });
      }
    } else if (ts.isExportAssignment(node)) {
      // Handle export = or export default
      result.exports.push({
        name: 'default',
        type: 'variable',
        line,
        isDefault: true
      });
    }
  }

  private extractFunction(node: ts.FunctionDeclaration, sourceFile: ts.SourceFile, result: ParsedFile): void {
    if (!node.name) return;

    const name = node.name.text;
    const line = this.getLineNumber(node, sourceFile);
    const id = this.generateNodeId(result.file, 'function', name, line);

    const codeNode: CodeNode = {
      id,
      type: 'function',
      name,
      file: result.file,
      line,
      metadata: {
        parameters: node.parameters.map(p => p.name.getText()),
        isAsync: !!(node.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword)),
        isExported: !!(node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword))
      }
    };

    result.nodes.push(codeNode);

    // Extract function calls within this function
    this.extractCallsFromNode(node, sourceFile, result, id);
  }

  private extractMethod(node: ts.MethodDeclaration, sourceFile: ts.SourceFile, result: ParsedFile): void {
    const name = node.name.getText();
    const line = this.getLineNumber(node, sourceFile);
    const id = this.generateNodeId(result.file, 'function', name, line);

    const codeNode: CodeNode = {
      id,
      type: 'function',
      name,
      file: result.file,
      line,
      metadata: {
        isMethod: true,
        parameters: node.parameters.map(p => p.name.getText()),
        isAsync: !!(node.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword)),
        isStatic: !!(node.modifiers?.some(m => m.kind === ts.SyntaxKind.StaticKeyword)),
        visibility: this.getVisibility(node.modifiers)
      }
    };

    result.nodes.push(codeNode);

    // Extract function calls within this method
    this.extractCallsFromNode(node, sourceFile, result, id);
  }

  private extractClass(node: ts.ClassDeclaration, sourceFile: ts.SourceFile, result: ParsedFile): void {
    if (!node.name) return;

    const name = node.name.text;
    const line = this.getLineNumber(node, sourceFile);
    const id = this.generateNodeId(result.file, 'class', name, line);

    const codeNode: CodeNode = {
      id,
      type: 'class',
      name,
      file: result.file,
      line,
      metadata: {
        isExported: !!(node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)),
        isAbstract: !!(node.modifiers?.some(m => m.kind === ts.SyntaxKind.AbstractKeyword))
      }
    };

    result.nodes.push(codeNode);

    // Extract inheritance relationships
    if (node.heritageClauses) {
      node.heritageClauses.forEach(clause => {
        clause.types.forEach(type => {
          const parentName = type.expression.getText();
          const relationship = clause.token === ts.SyntaxKind.ExtendsKeyword ? 'extends' : 'implements';
          
          result.edges.push({
            source: id,
            target: this.generateNodeId(result.file, 'class', parentName, 0), // We don't know the line
            relationship: relationship as any,
            metadata: { parentClass: parentName }
          });
        });
      });
    }

    // Extract class members and create relationships
    node.members.forEach(member => {
      if (ts.isMethodDeclaration(member) || ts.isPropertyDeclaration(member)) {
        const memberName = member.name?.getText() || '';
        const memberLine = this.getLineNumber(member, sourceFile);
        const memberType = ts.isMethodDeclaration(member) ? 'function' : 'property';
        const memberId = this.generateNodeId(result.file, memberType, memberName, memberLine);
        
        // Create relationship: class -> defines -> method/property
        result.edges.push({
          source: id,
          target: memberId,
          relationship: 'defines',
          metadata: {
            memberType,
            memberName,
            isStatic: !!(member.modifiers?.some(m => m.kind === ts.SyntaxKind.StaticKeyword)),
            visibility: this.getVisibility(member.modifiers)
          }
        });
      }
    });
  }

  private extractInterface(node: ts.InterfaceDeclaration, sourceFile: ts.SourceFile, result: ParsedFile): void {
    const name = node.name.text;
    const line = this.getLineNumber(node, sourceFile);
    const id = this.generateNodeId(result.file, 'interface', name, line);

    const codeNode: CodeNode = {
      id,
      type: 'interface',
      name,
      file: result.file,
      line,
      metadata: {
        isExported: !!(node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword))
      }
    };

    result.nodes.push(codeNode);

    // Extract interface inheritance
    if (node.heritageClauses) {
      node.heritageClauses.forEach(clause => {
        clause.types.forEach(type => {
          const parentName = type.expression.getText();
          
          result.edges.push({
            source: id,
            target: this.generateNodeId(result.file, 'interface', parentName, 0),
            relationship: 'extends',
            metadata: { parentInterface: parentName }
          });
        });
      });
    }
  }

  private extractVariable(node: ts.VariableDeclaration, sourceFile: ts.SourceFile, result: ParsedFile): void {
    // Extract simple variable names only
    let name: string;
    if (ts.isIdentifier(node.name)) {
      name = node.name.text;
    } else if (ts.isObjectBindingPattern(node.name) || ts.isArrayBindingPattern(node.name)) {
      // For destructuring patterns, create a simplified name
      name = 'destructured';
    } else {
      // Skip complex patterns
      return;
    }
    
    const line = this.getLineNumber(node, sourceFile);
    const id = this.generateNodeId(result.file, 'variable', name, line);

    const codeNode: CodeNode = {
      id,
      type: 'variable',
      name,
      file: result.file,
      line,
      metadata: {
        hasInitializer: !!node.initializer
      }
    };

    result.nodes.push(codeNode);
  }

  private extractFunctionCall(node: ts.CallExpression, sourceFile: ts.SourceFile, result: ParsedFile): void {
    // This will be used to create edges between functions
    // We'll extract this information when processing functions/methods
  }

  private extractCallsFromNode(node: ts.Node, sourceFile: ts.SourceFile, result: ParsedFile, sourceNodeId: string): void {
    const visit = (child: ts.Node) => {
      if (ts.isCallExpression(child)) {
        // Extract ALL types of function/method calls
        const callInfo = this.extractCallInfo(child, sourceFile);
        if (callInfo) {
          const line = this.getLineNumber(child, sourceFile);
          
          // Create an edge representing the function/method call
          result.edges.push({
            source: sourceNodeId,
            target: this.generateNodeId(result.file, 'function', callInfo.name, 0), // Will be resolved in second pass
            relationship: 'calls',
            metadata: {
              callLine: line,
              functionName: callInfo.name,
              callType: callInfo.type,
              receiver: callInfo.receiver,
              isChained: callInfo.isChained,
              isDynamic: callInfo.isDynamic
            }
          });
        }
      } else if (ts.isNewExpression(child)) {
        // Handle constructor calls: new ClassName()
        const className = this.extractClassName(child.expression);
        if (className) {
          const line = this.getLineNumber(child, sourceFile);
          result.edges.push({
            source: sourceNodeId,
            target: this.generateNodeId(result.file, 'class', className, 0),
            relationship: 'uses',
            metadata: {
              callLine: line,
              callType: 'constructor',
              className
            }
          });
        }
      }
      
      ts.forEachChild(child, visit);
    };

    ts.forEachChild(node, visit);
  }

  private extractCallInfo(node: ts.CallExpression, sourceFile: ts.SourceFile): { 
    name: string; 
    type: string; 
    receiver?: string;
    isChained: boolean;
    isDynamic: boolean;
  } | null {
    return this.extractExpressionInfo(node.expression);
  }

  private extractExpressionInfo(expression: ts.Expression): { 
    name: string; 
    type: string; 
    receiver?: string;
    isChained: boolean;
    isDynamic: boolean;
  } | null {
    // Simple function call: functionName()
    if (ts.isIdentifier(expression)) {
      return { 
        name: expression.text, 
        type: 'function',
        isChained: false,
        isDynamic: false
      };
    }
    
    // Method call: obj.method() or this.method()
    if (ts.isPropertyAccessExpression(expression)) {
      const receiver = expression.expression.getText();
      const methodName = expression.name.text;
      
      // Check if this is a chained call
      const isChained = ts.isCallExpression(expression.expression);
      
      return { 
        name: methodName, 
        type: 'method',
        receiver: receiver,
        isChained,
        isDynamic: false
      };
    }
    
    // Dynamic call: obj[methodName]() or obj['method']()
    if (ts.isElementAccessExpression(expression)) {
      const receiver = expression.expression.getText();
      
      // Try to extract the method name if it's a string literal
      if (ts.isStringLiteral(expression.argumentExpression)) {
        return {
          name: expression.argumentExpression.text,
          type: 'method',
          receiver: receiver,
          isChained: false,
          isDynamic: true
        };
      }
      
      // For dynamic expressions, use the expression text
      const dynamicKey = expression.argumentExpression.getText();
      return {
        name: `[${dynamicKey}]`,
        type: 'method',
        receiver: receiver,
        isChained: false,
        isDynamic: true
      };
    }
    
    // Super call: super.method()
    if (expression.kind === ts.SyntaxKind.SuperKeyword) {
      return {
        name: 'super',
        type: 'super',
        isChained: false,
        isDynamic: false
      };
    }
    
    // Call expression (chained calls): getObj().method()
    if (ts.isCallExpression(expression)) {
      // Recursively extract the final call
      const innerInfo = this.extractExpressionInfo(expression.expression);
      if (innerInfo) {
        return {
          ...innerInfo,
          isChained: true
        };
      }
    }
    
    // Other complex expressions
    return null;
  }

  private extractClassName(expression: ts.Expression): string | null {
    if (ts.isIdentifier(expression)) {
      return expression.text;
    } else if (ts.isPropertyAccessExpression(expression)) {
      // Handle namespaced classes: namespace.ClassName
      return expression.name.text;
    }
    return null;
  }

  private getLineNumber(node: ts.Node, sourceFile: ts.SourceFile): number {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
    return line + 1; // Convert to 1-based line numbers
  }

  private getVisibility(modifiers?: ts.NodeArray<ts.ModifierLike>): string {
    if (!modifiers) return 'public';
    
    if (modifiers.some(m => m.kind === ts.SyntaxKind.PrivateKeyword)) return 'private';
    if (modifiers.some(m => m.kind === ts.SyntaxKind.ProtectedKeyword)) return 'protected';
    return 'public';
  }

  private generateNodeId(file: string, type: string, name: string, line: number): string {
    const relativePath = path.relative(process.cwd(), file);
    // Sanitize the name to avoid issues with special characters in Cypher queries
    const sanitizedName = this.sanitizeForNodeId(name);
    return `${relativePath}:${type}:${sanitizedName}:${line}`;
  }

  private sanitizeForNodeId(name: string): string {
    // Remove or encode problematic characters
    return name
      .replace(/[\r\n]+/g, ' ') // Replace newlines with spaces
      .replace(/'/g, "\\'") // Escape single quotes
      .replace(/"/g, '\\"') // Escape double quotes
      .replace(/[\x00-\x1F\x7F]/g, '') // Remove control characters
      .trim()
      .substring(0, 200); // Limit length to prevent excessively long IDs
  }
}