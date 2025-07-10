/**
 * OpenAI client wrapper for Camille
 * Handles all interactions with OpenAI API including completions and embeddings
 */

import OpenAI from 'openai';
import { CamilleConfig } from './config';
import { FILE_READER_TOOL } from './prompts';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Result from a code review
 */
export interface ReviewResult {
  securityIssues: string[];
  complianceViolations: string[];
  codeQualityIssues: string[];
  suggestions: string[];
  approvalStatus: 'APPROVED' | 'NEEDS_CHANGES' | 'REQUIRES_SECURITY_REVIEW';
  rawResponse: string;
}

/**
 * OpenAI client wrapper class
 */
export class OpenAIClient {
  private client: OpenAI;
  private config: CamilleConfig;
  private workingDirectory: string;

  constructor(apiKey: string, config: CamilleConfig, workingDirectory: string) {
    this.client = new OpenAI({ apiKey });
    this.config = config;
    this.workingDirectory = workingDirectory;
  }

  /**
   * Performs a code review using OpenAI
   */
  async reviewCode(
    systemPrompt: string,
    userPrompt: string,
    useDetailedModel: boolean = true
  ): Promise<ReviewResult> {
    const model = useDetailedModel ? this.config.models.review : this.config.models.quick;

    try {
      const response = await this.client.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: this.config.temperature,
        max_tokens: this.config.maxTokens,
        tools: [FILE_READER_TOOL],
        tool_choice: 'auto'
      });

      // Handle tool calls (file reading)
      let finalResponse = response;
      const toolCalls = response.choices[0]?.message?.tool_calls;

      if (toolCalls && toolCalls.length > 0) {
        const toolResults = await this.handleToolCalls(toolCalls);
        
        // Continue conversation with tool results
        finalResponse = await this.client.chat.completions.create({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
            response.choices[0].message,
            ...toolResults
          ],
          temperature: this.config.temperature,
          max_tokens: this.config.maxTokens
        });
      }

      const content = finalResponse.choices[0]?.message?.content || '';
      return this.parseReviewResult(content);

    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`OpenAI API error: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Handles tool calls for file reading
   */
  private async handleToolCalls(toolCalls: any[]): Promise<any[]> {
    const results = [];

    for (const toolCall of toolCalls) {
      if (toolCall.function.name === 'read_file') {
        const args = JSON.parse(toolCall.function.arguments);
        const filePath = path.join(this.workingDirectory, args.path);
        
        let content: string;
        try {
          if (fs.existsSync(filePath)) {
            content = fs.readFileSync(filePath, 'utf8');
            // Truncate very large files
            if (content.length > 50000) {
              content = content.substring(0, 50000) + '\n\n[... file truncated ...]';
            }
          } else {
            content = `File not found: ${args.path}`;
          }
        } catch (error) {
          content = `Error reading file: ${error}`;
        }

        results.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content
        });
      }
    }

    return results;
  }

  /**
   * Parses the review result from OpenAI response
   */
  private parseReviewResult(content: string): ReviewResult {
    const result: ReviewResult = {
      securityIssues: [],
      complianceViolations: [],
      codeQualityIssues: [],
      suggestions: [],
      approvalStatus: 'APPROVED',
      rawResponse: content
    };

    // Parse structured sections from the response
    const sections = content.split(/\*\*([^*]+)\*\*:/);
    
    for (let i = 1; i < sections.length; i += 2) {
      const sectionTitle = sections[i].trim().toLowerCase();
      const sectionContent = sections[i + 1]?.trim() || '';
      
      const items = sectionContent
        .split(/[-•]\s+/)
        .filter(item => item.trim())
        .map(item => item.trim());

      switch (sectionTitle) {
        case 'security issues':
          result.securityIssues = items;
          break;
        case 'compliance violations':
          result.complianceViolations = items;
          break;
        case 'code quality':
          result.codeQualityIssues = items;
          break;
        case 'suggestions':
          result.suggestions = items;
          break;
        case 'approval status':
          const status = sectionContent.trim().toUpperCase();
          if (status.includes('REQUIRES_SECURITY_REVIEW')) {
            result.approvalStatus = 'REQUIRES_SECURITY_REVIEW';
          } else if (status.includes('NEEDS_CHANGES')) {
            result.approvalStatus = 'NEEDS_CHANGES';
          } else if (status.includes('APPROVED')) {
            result.approvalStatus = 'APPROVED';
          }
          break;
      }
    }

    // Determine approval status based on issues found
    if (result.securityIssues.length > 0) {
      result.approvalStatus = 'REQUIRES_SECURITY_REVIEW';
    } else if (result.complianceViolations.length > 0 || result.codeQualityIssues.length > 0) {
      result.approvalStatus = 'NEEDS_CHANGES';
    }

    return result;
  }

  /**
   * Generates embeddings for code content
   */
  async generateEmbedding(content: string): Promise<number[]> {
    try {
      const response = await this.client.embeddings.create({
        model: this.config.models.embedding,
        input: content,
        encoding_format: 'float'
      });

      return response.data[0].embedding;
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Embedding generation error: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Performs a simple completion without tools
   */
  async complete(prompt: string, model?: string): Promise<string> {
    try {
      const response = await this.client.chat.completions.create({
        model: model || this.config.models.quick,
        messages: [{ role: 'user', content: prompt }],
        temperature: this.config.temperature,
        max_tokens: this.config.maxTokens
      });

      return response.choices[0]?.message?.content || '';
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`OpenAI API error: ${error.message}`);
      }
      throw error;
    }
  }
}