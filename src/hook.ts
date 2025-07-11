/**
 * Claude Code hook implementation for Camille
 * Validates code changes against project rules using OpenAI
 */

import { ConfigManager } from './config';
import { ReviewResult } from './openai-client';
import { LLMClient } from './llm-client';
import { 
  SYSTEM_PROMPT, 
  COMPREHENSIVE_SYSTEM_PROMPT,
  REVIEW_PROMPT_TEMPLATE, 
  COMPREHENSIVE_REVIEW_TEMPLATE,
  populateTemplate 
} from './prompts';
import { logger } from './logger';
import * as path from 'path';
import * as fs from 'fs';
import { EmbeddingsIndex } from './embeddings';

/**
 * Hook input structure from Claude Code
 */
interface HookInput {
  session_id: string;
  transcript_path: string;
  hook_event_name: string;
  tool_name?: string;
  tool_input?: any;
  // Legacy format support
  tool?: {
    name: string;
    input?: any;
  };
}

/**
 * Hook output structure for Claude Code
 */
interface HookOutput {
  continue: boolean;
  decision?: 'approve' | 'block';
  reason?: string;
}

/**
 * Main hook handler class
 */
export class CamilleHook {
  private configManager: ConfigManager;
  private llmClient: LLMClient;
  private embeddingsIndex?: EmbeddingsIndex;

  constructor() {
    this.configManager = new ConfigManager();
    const config = this.configManager.getConfig();
    const workingDir = process.cwd();
    
    // Don't create embeddings index in constructor - lazy load when needed
    // This prevents loading embeddings cache when running as a hook
    this.llmClient = new LLMClient(config, workingDir);
  }

  /**
   * Lazy loads the embeddings index when needed
   */
  private getEmbeddingsIndex(): EmbeddingsIndex {
    if (!this.embeddingsIndex) {
      this.embeddingsIndex = new EmbeddingsIndex(this.configManager);
      // Update the LLMClient with the embeddings index
      const config = this.configManager.getConfig();
      const workingDir = process.cwd();
      this.llmClient = new LLMClient(config, workingDir, this.embeddingsIndex);
    }
    return this.embeddingsIndex;
  }

  /**
   * Processes the hook input and returns a decision
   */
  async processHook(input: HookInput): Promise<HookOutput> {
    try {
      logger.info('Hook called', { 
        event: input.hook_event_name, 
        tool: input.tool?.name,
        hasInput: !!input.tool?.input,
        toolInput: input.tool?.input ? Object.keys(input.tool.input) : []
      });
      
      // Only process PreToolUse events for code editing tools
      if (input.hook_event_name !== 'PreToolUse') {
        logger.debug('Skipping non-PreToolUse event');
        console.error(`[DEBUG] Skipping event: ${input.hook_event_name} (not PreToolUse)`);
        return { continue: true };
      }

      // Handle both new format (tool_name/tool_input) and legacy format (tool.name/tool.input)
      const toolName = input.tool_name || input.tool?.name;
      const toolInput = input.tool_input || input.tool?.input;
      
      if (!toolName) {
        console.error('[DEBUG] No tool name provided in input');
        return { continue: true };
      }
      
      console.error(`[DEBUG] Tool name: ${toolName}`);
      
      if (!this.isCodeEditingTool(toolName)) {
        logger.debug('Skipping non-code-editing tool', { toolName });
        console.error(`[DEBUG] Skipping tool: ${toolName} (not in Edit/MultiEdit/Write list)`);
        return { continue: true };
      }

      // Create a tool object for backward compatibility
      const tool = {
        name: toolName,
        input: toolInput
      };

      // Extract code changes from the tool input
      console.error('[DEBUG] Extracting code changes from tool:', tool.name);
      const codeChanges = this.extractCodeChanges(tool);
      if (!codeChanges) {
        logger.debug('No code changes extracted');
        console.error('[DEBUG] No code changes extracted from tool input');
        return { 
          continue: true,
          decision: 'approve' as const,
          reason: 'No code changes to review'
        };
      }
      
      console.error(`[DEBUG] Code changes extracted, length: ${codeChanges.length}`);

      logger.info('Performing code review', { 
        changesLength: codeChanges.length
      });

      // Perform the review
      const review = await this.performReview(codeChanges);

      // Make decision based on review
      const decision = this.makeDecision(review);
      logger.info('Review decision', { 
        decision: decision.decision,
        continue: decision.continue 
      });
      
      return decision;

    } catch (error) {
      // Fail fast as requested
      console.error('Camille hook error:', error);
      return {
        continue: false,
        decision: 'block',
        reason: `Camille review failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    }
  }

  /**
   * Checks if the tool is a code editing tool
   */
  private isCodeEditingTool(toolName: string): boolean {
    const codeEditingTools = ['Edit', 'MultiEdit', 'Write', 'Update', 'Create'];
    return codeEditingTools.includes(toolName);
  }

  /**
   * Extracts code changes from tool input
   */
  private extractCodeChanges(tool: any): string | null {
    const { name, input } = tool;

    switch (name) {
      case 'Edit':
        return this.formatEditChange(input);
      case 'MultiEdit':
        return this.formatMultiEditChanges(input);
      case 'Write':
      case 'Create':  // Create is like Write
        return this.formatWriteChange(input);
      case 'Update':  // Update is like Edit
        return this.formatEditChange(input);
      default:
        logger.warn('Unknown tool for code extraction', { toolName: name });
        return null;
    }
  }

  /**
   * Formats a single edit change
   */
  private formatEditChange(input: any): string {
    return `File: ${input.file_path}
Action: Edit
Old: ${input.old_string}
New: ${input.new_string}`;
  }

  /**
   * Formats multiple edit changes
   */
  private formatMultiEditChanges(input: any): string {
    const changes = input.edits.map((edit: any, index: number) => 
      `Edit ${index + 1}:
  Old: ${edit.old_string}
  New: ${edit.new_string}`
    ).join('\n\n');

    return `File: ${input.file_path}
Action: MultiEdit
Changes:
${changes}`;
  }

  /**
   * Formats a write change
   */
  private formatWriteChange(input: any): string {
    return `File: ${input.file_path}
Action: Write (Full file)
Content:
${input.content}`;
  }

  /**
   * Reads project context files (CLAUDE.md, README) and extracts linked files
   */
  private async readProjectContext(): Promise<string> {
    const context: string[] = [];
    const workingDir = process.cwd();
    
    // Read CLAUDE.md if it exists
    const claudeMdPath = path.join(workingDir, 'CLAUDE.md');
    if (fs.existsSync(claudeMdPath)) {
      try {
        const content = fs.readFileSync(claudeMdPath, 'utf8');
        context.push('=== CLAUDE.md (Project Rules) ===\n' + content);
        
        // Extract linked files from CLAUDE.md
        const linkedFiles = this.extractLinkedFiles(content, workingDir);
        for (const linkedFile of linkedFiles) {
          if (fs.existsSync(linkedFile)) {
            try {
              const linkedContent = fs.readFileSync(linkedFile, 'utf8');
              context.push(`\n=== ${path.relative(workingDir, linkedFile)} ===\n${linkedContent}`);
            } catch (error) {
              logger.warn('Failed to read linked file', { file: linkedFile, error });
            }
          }
        }
      } catch (error) {
        logger.warn('Failed to read CLAUDE.md', { error });
      }
    }
    
    // Read README.md if it exists
    const readmePath = path.join(workingDir, 'README.md');
    if (fs.existsSync(readmePath)) {
      try {
        const content = fs.readFileSync(readmePath, 'utf8');
        context.push('\n=== README.md ===\n' + content);
        
        // Extract linked files from README
        const linkedFiles = this.extractLinkedFiles(content, workingDir);
        for (const linkedFile of linkedFiles) {
          if (fs.existsSync(linkedFile) && !context.some(c => c.includes(linkedFile))) {
            try {
              const linkedContent = fs.readFileSync(linkedFile, 'utf8');
              context.push(`\n=== ${path.relative(workingDir, linkedFile)} ===\n${linkedContent}`);
            } catch (error) {
              logger.warn('Failed to read linked file', { file: linkedFile, error });
            }
          }
        }
      } catch (error) {
        logger.warn('Failed to read README.md', { error });
      }
    }
    
    return context.join('\n\n');
  }

  /**
   * Extracts linked file paths from markdown content
   */
  private extractLinkedFiles(content: string, workingDir: string): string[] {
    const linkedFiles: string[] = [];
    
    // Match markdown links: [text](path)
    const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
    let match;
    
    while ((match = linkRegex.exec(content)) !== null) {
      const linkPath = match[2];
      
      // Skip URLs and anchors
      if (linkPath.startsWith('http') || linkPath.startsWith('#')) {
        continue;
      }
      
      // Skip image files
      if (/\.(png|jpg|jpeg|gif|svg|ico)$/i.test(linkPath)) {
        continue;
      }
      
      // Resolve relative paths
      const resolvedPath = path.isAbsolute(linkPath) 
        ? linkPath 
        : path.join(workingDir, linkPath);
      
      linkedFiles.push(resolvedPath);
    }
    
    // Also match raw file references in backticks
    const backtickRegex = /`([^`]+\.[a-zA-Z]+)`/g;
    while ((match = backtickRegex.exec(content)) !== null) {
      const filePath = match[1];
      
      // Skip if it looks like code rather than a file path
      if (filePath.includes('(') || filePath.includes(';') || filePath.includes('{')) {
        continue;
      }
      
      const resolvedPath = path.isAbsolute(filePath)
        ? filePath
        : path.join(workingDir, filePath);
      
      // Only include if it's a reasonable file path
      if (resolvedPath.split(path.sep).length <= 10) {
        linkedFiles.push(resolvedPath);
      }
    }
    
    // Remove duplicates
    return [...new Set(linkedFiles)];
  }

  /**
   * Performs the code review
   */
  private async performReview(codeChanges: string): Promise<ReviewResult> {
    const config = this.configManager.getConfig();
    
    // Read project context files
    const projectContext = await this.readProjectContext();
    
    // Use comprehensive review if enabled
    if (config.expansiveReview) {
      // Load custom prompts or use comprehensive defaults
      const customSystemPrompt = config.customPrompts?.system || 
                                this.configManager.loadCustomPrompt('system') || 
                                COMPREHENSIVE_SYSTEM_PROMPT;
      
      const reviewTemplate = config.customPrompts?.review || 
                            this.configManager.loadCustomPrompt('review') || 
                            COMPREHENSIVE_REVIEW_TEMPLATE;

      // Prepare the user prompt with project context
      const userPromptTemplate = projectContext 
        ? `${projectContext}\n\n${reviewTemplate}`
        : reviewTemplate;
        
      const userPrompt = populateTemplate(userPromptTemplate, {
        workingDirectory: process.cwd(),
        filesChanged: this.extractFilePaths(codeChanges),
        codeChanges
      });

      // Determine if we should use detailed model based on change size
      const useDetailedModel = codeChanges.length > 500 || codeChanges.includes('security');

      return await this.llmClient.comprehensiveReview(
        customSystemPrompt,
        userPrompt,
        useDetailedModel
      );
    } else {
      // Legacy review without codebase access
      const customSystemPrompt = config.customPrompts?.system || 
                                this.configManager.loadCustomPrompt('system') || 
                                SYSTEM_PROMPT;
      
      const reviewTemplate = config.customPrompts?.review || 
                            this.configManager.loadCustomPrompt('review') || 
                            REVIEW_PROMPT_TEMPLATE;

      // Prepare the user prompt with project context
      const userPromptTemplate = projectContext 
        ? `${projectContext}\n\n${reviewTemplate}`
        : reviewTemplate;
        
      const userPrompt = populateTemplate(userPromptTemplate, {
        workingDirectory: process.cwd(),
        filesChanged: this.extractFilePaths(codeChanges),
        codeChanges
      });

      // Determine if we should use detailed model based on change size
      const useDetailedModel = codeChanges.length > 500 || codeChanges.includes('security');

      return await this.llmClient.reviewCode(
        customSystemPrompt,
        userPrompt,
        useDetailedModel
      );
    }
  }

  /**
   * Extracts file paths from code changes
   */
  private extractFilePaths(codeChanges: string): string {
    const fileMatch = codeChanges.match(/File: (.+)/g);
    if (fileMatch) {
      return fileMatch.map(m => m.replace('File: ', '')).join(', ');
    }
    return 'Unknown';
  }

  /**
   * Makes a decision based on the review result
   */
  private makeDecision(review: ReviewResult): HookOutput {
    let reason = '';
    
    // Add metrics to reason if available
    if (review.metrics) {
      const m = review.metrics;
      reason = `Code Review Metrics:\n`;
      reason += `• Security: ${m.security}/10\n`;
      reason += `• Accuracy: ${m.accuracy}/10\n`;
      reason += `• Algorithmic Efficiency: ${m.algorithmicEfficiency}/10\n`;
      reason += `• Code Reuse: ${m.codeReuse}/10\n`;
      reason += `• Operational Excellence: ${m.operationalExcellence}/10\n`;
      reason += `• Style Compliance: ${m.styleCompliance}/10\n`;
      reason += `• Object-Oriented Design: ${m.objectOriented}/10\n`;
      reason += `• Architecture Patterns: ${m.patterns}/10\n\n`;
    }
    
    switch (review.approvalStatus) {
      case 'APPROVED':
        return {
          continue: true,
          decision: 'approve',
          reason: reason + 'Code review passed: No critical issues found.'
        };

      case 'NEEDS_CHANGES':
        const issues = [
          ...review.complianceViolations.map(v => `Compliance: ${v}`),
          ...review.codeQualityIssues.map(q => `Quality: ${q}`)
        ];
        return {
          continue: false,
          decision: 'block',
          reason: reason + `Code review failed:\n${issues.join('\n')}`
        };

      case 'REQUIRES_SECURITY_REVIEW':
        const securityIssues = review.securityIssues.map(s => `Security: ${s}`);
        return {
          continue: false,
          decision: 'block',
          reason: reason + `SECURITY REVIEW REQUIRED:\n${securityIssues.join('\n')}`
        };

      default:
        return {
          continue: true,
          decision: 'approve',
          reason: reason + 'Review completed'
        };
    }
  }
}

/**
 * Main entry point for the hook
 */
export async function runHook(): Promise<void> {
  // Write to stderr for debugging (won't interfere with JSON output)
  console.error('[DEBUG] Hook process started');
  
  try {
    logger.info('Hook process started, waiting for stdin');
    
    // Read input from stdin
    let inputData = '';
    process.stdin.setEncoding('utf8');
    
    for await (const chunk of process.stdin) {
      inputData += chunk;
    }

    logger.info('Received input data', { length: inputData.length });

    if (!inputData) {
      logger.error('No input data received');
      console.log(JSON.stringify({
        continue: true,
        decision: 'approve',
        reason: 'No input data received'
      }));
      process.exit(0);
    }

    const input: HookInput = JSON.parse(inputData);
    console.error('[DEBUG] Full input structure:', JSON.stringify(input, null, 2));
    logger.info('Parsed input', { event: input.hook_event_name, tool: input.tool?.name });
    
    const hook = new CamilleHook();
    const output = await hook.processHook(input);

    // Write output to stdout
    console.log(JSON.stringify(output));
    process.exit(output.continue ? 0 : 2);

  } catch (error) {
    console.error('Hook error:', error);
    console.error('Stack trace:', error instanceof Error ? error.stack : 'No stack trace');
    
    // Return a continue response on error to avoid blocking
    // Log the error but don't block the user's work
    console.log(JSON.stringify({
      continue: true,
      decision: 'approve',
      reason: 'Hook error - defaulting to approve'
    }));
    process.exit(0);
  }
}