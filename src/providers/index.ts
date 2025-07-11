/**
 * Provider factory and exports
 */

import { AnthropicProvider } from './anthropic';
import { OpenAIProvider } from './openai';
import { LLMProviderInterface, LLMProvider, ProviderConfig } from './types';

export * from './types';
export * from './models';
export { AnthropicProvider } from './anthropic';
export { OpenAIProvider } from './openai';

/**
 * Create an LLM provider instance
 */
export function createProvider(config: { provider: LLMProvider; apiKey: string }): LLMProviderInterface {
  switch (config.provider) {
    case 'anthropic':
      return new AnthropicProvider(config.apiKey);
    case 'openai':
      return new OpenAIProvider(config.apiKey);
    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }
}

/**
 * Get provider from model ID
 */
export function getProviderFromModel(modelId: string): LLMProvider | null {
  if (modelId.startsWith('claude-') || modelId.includes('claude')) {
    return 'anthropic';
  } else if (modelId.startsWith('gpt-') || modelId.startsWith('o1') || modelId.startsWith('o3') || modelId.includes('embedding')) {
    return 'openai';
  }
  return null;
}