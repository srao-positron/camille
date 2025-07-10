/**
 * Main entry point for Camille
 * Exports all public APIs for programmatic usage
 */

export { ConfigManager, CamilleConfig } from './config';
export { CamilleServer, ServerManager, ServerStatus } from './server';
export { CamilleMCPServer } from './mcp-server';
export { CamilleHook, runHook } from './hook';
export { OpenAIClient, ReviewResult } from './openai-client';
export { EmbeddingsIndex, SearchResult, EmbeddedFile } from './embeddings';
export * from './prompts';