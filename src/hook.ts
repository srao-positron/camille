/**
 * Claude Code hook implementation for Camille
 * Validates code changes against project rules using OpenAI
 */

import { ConfigManager } from './config';
import { OpenAIClient, ReviewResult } from './openai-client';
import { SYSTEM_PROMPT, REVIEW_PROMPT_TEMPLATE, populateTemplate } from './prompts';
import { logger } from './logger';
import * as path from 'path';

/**
 * Hook input structure from Claude Code
 */
interface HookInput {
  session_id: string;
  transcript_path: string;
  hook_event_name: string;
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
  private openaiClient: OpenAIClient;

  constructor() {
    this.configManager = new ConfigManager();
    const config = this.configManager.getConfig();
    const apiKey = this.configManager.getApiKey();
    const workingDir = process.cwd();
    
    this.openaiClient = new OpenAIClient(apiKey, config, workingDir);
  }

  /**
   * Processes the hook input and returns a decision
   */
  async processHook(input: HookInput): Promise<HookOutput> {
    try {
      logger.info('Hook called', { 
        event: input.hook_event_name, 
        tool: input.tool?.name,
        hasInput: !!input.tool?.input 
      });
      
      // Only process PreToolUse events for code editing tools
      if (input.hook_event_name !== 'PreToolUse') {
        logger.debug('Skipping non-PreToolUse event');
        return { continue: true };
      }

      const tool = input.tool;
      if (!tool || !this.isCodeEditingTool(tool.name)) {
        logger.debug('Skipping non-code-editing tool', { toolName: tool?.name });
        return { continue: true };
      }

      // Extract code changes from the tool input
      const codeChanges = this.extractCodeChanges(tool);
      if (!codeChanges) {
        logger.debug('No code changes extracted');
        return { continue: true };
      }

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
    const codeEditingTools = ['Edit', 'MultiEdit', 'Write'];
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
        return this.formatWriteChange(input);
      default:
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
   * Performs the code review
   */
  private async performReview(codeChanges: string): Promise<ReviewResult> {
    const config = this.configManager.getConfig();
    
    // Load custom prompts if available
    const customSystemPrompt = config.customPrompts?.system || 
                              this.configManager.loadCustomPrompt('system') || 
                              SYSTEM_PROMPT;
    
    const reviewTemplate = config.customPrompts?.review || 
                          this.configManager.loadCustomPrompt('review') || 
                          REVIEW_PROMPT_TEMPLATE;

    // Prepare the user prompt
    const userPrompt = populateTemplate(reviewTemplate, {
      workingDirectory: process.cwd(),
      filesChanged: this.extractFilePaths(codeChanges),
      codeChanges
    });

    // Determine if we should use detailed model based on change size
    const useDetailedModel = codeChanges.length > 500 || codeChanges.includes('security');

    return await this.openaiClient.reviewCode(
      customSystemPrompt,
      userPrompt,
      useDetailedModel
    );
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
    switch (review.approvalStatus) {
      case 'APPROVED':
        return {
          continue: true,
          decision: 'approve',
          reason: 'Code review passed: No security or compliance issues found.'
        };

      case 'NEEDS_CHANGES':
        const issues = [
          ...review.complianceViolations.map(v => `Compliance: ${v}`),
          ...review.codeQualityIssues.map(q => `Quality: ${q}`)
        ];
        return {
          continue: false,
          decision: 'block',
          reason: `Code review failed:\n${issues.join('\n')}`
        };

      case 'REQUIRES_SECURITY_REVIEW':
        const securityIssues = review.securityIssues.map(s => `Security: ${s}`);
        return {
          continue: false,
          decision: 'block',
          reason: `SECURITY REVIEW REQUIRED:\n${securityIssues.join('\n')}`
        };

      default:
        return {
          continue: true,
          decision: 'approve',
          reason: 'Review completed'
        };
    }
  }
}

/**
 * Main entry point for the hook
 */
export async function runHook(): Promise<void> {
  try {
    // Read input from stdin
    let inputData = '';
    process.stdin.setEncoding('utf8');
    
    for await (const chunk of process.stdin) {
      inputData += chunk;
    }

    const input: HookInput = JSON.parse(inputData);
    const hook = new CamilleHook();
    const output = await hook.processHook(input);

    // Write output to stdout
    console.log(JSON.stringify(output));
    process.exit(output.continue ? 0 : 2);

  } catch (error) {
    console.error('Hook error:', error);
    // Fail fast with blocking error
    console.log(JSON.stringify({
      continue: false,
      decision: 'block',
      reason: `Hook execution failed: ${error}`
    }));
    process.exit(2);
  }
}