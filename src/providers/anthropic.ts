/**
 * Anthropic Claude provider implementation
 */

import Anthropic from '@anthropic-ai/sdk';
import { 
  LLMProviderInterface, 
  LLMRequestParams, 
  LLMResponse, 
  ModelInfo,
  LLMMessage,
  LLMTool
} from './types';
import { ANTHROPIC_MODELS } from './models';
import { logger } from '../logger';

/**
 * Convert our generic tool format to Anthropic's format
 */
function convertToAnthropicTool(tool: LLMTool): Anthropic.Tool {
  return {
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters as Anthropic.Tool.InputSchema
  };
}

/**
 * Convert our generic message format to Anthropic's format
 */
function convertToAnthropicMessages(messages: LLMMessage[]): Anthropic.MessageParam[] {
  const anthropicMessages: Anthropic.MessageParam[] = [];
  
  for (const msg of messages) {
    if (msg.role === 'system') {
      // System messages are handled separately in Anthropic
      continue;
    }
    
    if (msg.role === 'tool') {
      // Tool results in Anthropic format
      anthropicMessages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: msg.tool_call_id!,
          content: msg.content
        }]
      });
    } else {
      // Regular user/assistant messages
      anthropicMessages.push({
        role: msg.role as 'user' | 'assistant',
        content: msg.content
      });
    }
  }
  
  return anthropicMessages;
}

/**
 * Anthropic Claude provider
 */
export class AnthropicProvider implements LLMProviderInterface {
  name: 'anthropic' = 'anthropic';
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async complete(params: LLMRequestParams): Promise<LLMResponse> {
    const startTime = Date.now();
    
    try {
      // Extract system message if present
      const systemMessage = params.messages.find(m => m.role === 'system');
      const nonSystemMessages = params.messages.filter(m => m.role !== 'system');
      
      // Prepare request parameters
      const requestParams: Anthropic.MessageCreateParams = {
        model: params.model,
        messages: convertToAnthropicMessages(nonSystemMessages),
        max_tokens: params.maxTokens || 4096,
        temperature: params.temperature,
        ...(systemMessage && { system: systemMessage.content })
      };
      
      // Add tools if provided
      if (params.tools && params.tools.length > 0) {
        requestParams.tools = params.tools.map(convertToAnthropicTool);
        
        if (params.toolChoice === 'auto') {
          requestParams.tool_choice = { type: 'auto' };
        } else if (params.toolChoice === 'none') {
          requestParams.tool_choice = { type: 'none' };
        } else if (params.toolChoice && typeof params.toolChoice === 'object') {
          requestParams.tool_choice = {
            type: 'tool',
            name: params.toolChoice.name
          };
        }
      }
      
      logger.debug('Calling Anthropic API', {
        model: params.model,
        messageCount: params.messages.length,
        hasTools: !!params.tools,
        temperature: params.temperature
      });
      
      const response = await this.client.messages.create(requestParams);
      
      const duration = Date.now() - startTime;
      logger.info('Anthropic API call successful', {
        model: params.model,
        duration,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens
      });
      
      // Extract content and tool calls
      let content = '';
      const toolCalls: any[] = [];
      
      for (const block of response.content) {
        if (block.type === 'text') {
          content += block.text;
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input)
            }
          });
        }
      }
      
      return {
        content,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          totalTokens: response.usage.input_tokens + response.usage.output_tokens
        },
        model: response.model
      };
      
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error('Anthropic API call failed', error, {
        model: params.model,
        duration
      });
      
      if (error instanceof Error) {
        throw new Error(`Anthropic API error: ${error.message}`);
      }
      throw error;
    }
  }

  getAvailableModels(): ModelInfo[] {
    return ANTHROPIC_MODELS;
  }

  async validateApiKey(): Promise<boolean> {
    try {
      // Make a minimal API call to validate the key
      await this.client.messages.create({
        model: 'claude-3-haiku-20240307',
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 1
      });
      return true;
    } catch (error) {
      logger.debug('API key validation failed', { error });
      return false;
    }
  }
}