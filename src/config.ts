/**
 * Configuration management module for Camille
 * Handles API keys, model settings, and custom prompts
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { config as dotenvConfig } from 'dotenv';
import { MemoryConfig, DEFAULT_MEMORY_CONFIG } from './memory/types.js';

/**
 * Interface for Camille configuration options
 */
export interface CamilleConfig {
  // Legacy OpenAI API key (for backward compatibility)
  openaiApiKey?: string;
  
  // New provider configuration
  provider?: 'anthropic' | 'openai';
  anthropicApiKey?: string;
  
  models: {
    review: string;      // Model for detailed code review
    quick: string;       // Model for quick checks
    embedding?: string;  // Model for embeddings (OpenAI only)
  };
  temperature: number;   // Low temperature for consistent results (default: 0.1)
  maxTokens: number;     // Maximum tokens for responses
  maxFileSize?: number;  // Maximum file size in bytes for tool calls (default: 200000)
  maxIndexFileSize?: number; // Maximum file size in bytes for indexing (default: 500000)
  cacheToDisk: boolean;  // Whether to persist embeddings to disk
  expansiveReview: boolean; // Whether to provide LLM with codebase access for comprehensive reviews (default: true)
  ignorePatterns: string[]; // File patterns to ignore (gitignore format)
  customPrompts?: {
    system?: string;     // Custom system prompt
    review?: string;     // Custom review prompt template
  };
  watchedDirectories?: string[]; // Directories being monitored
  mcp?: {
    enabled: boolean;
    autoStart?: boolean;
  };
  hooks?: {
    enabled: boolean;
    tools?: string[];
  };
  autoStart?: {
    enabled: boolean;
    platform?: string;
    method?: string;
  };
  memory?: MemoryConfig; // Memory system configuration
  supastate?: {
    enabled: boolean;
    url?: string;
    apiKey?: string; // API key for authentication
    accessToken?: string; // Legacy JWT token (for backward compatibility)
    refreshToken?: string; // Legacy JWT refresh token (deprecated)
    expiresAt?: number; // Legacy expiration (deprecated)
    supabaseUrl?: string; // Legacy (deprecated)
    supabaseAnonKey?: string; // Legacy (deprecated)
    teamId?: string;
    userId?: string;
    email?: string;
    autoSync?: boolean;
    syncInterval?: number; // in minutes
    serverSideProcessing?: boolean; // Use new architecture
  };
}

/**
 * Default configuration values
 */
const DEFAULT_CONFIG: CamilleConfig = {
  provider: 'anthropic',  // Default to Anthropic
  models: {
    review: 'claude-opus-4-20250514',     // Claude Opus 4 for detailed reviews
    quick: 'claude-3-5-haiku-20241022',   // Claude 3.5 Haiku for quick checks
    embedding: 'text-embedding-3-large'    // Still use OpenAI for embeddings
  },
  temperature: 0.1,
  maxTokens: 4000,
  maxFileSize: 200000,    // 200KB for tool calls
  maxIndexFileSize: 500000, // 500KB for indexing
  cacheToDisk: true,
  expansiveReview: true,  // Enable comprehensive code reviews by default
  ignorePatterns: [
    'node_modules/**',
    '.git/**',
    'dist/**',
    '*.log',
    '*.tmp',
    '.DS_Store'
  ],
  memory: DEFAULT_MEMORY_CONFIG
};

/**
 * Configuration manager class
 */
export class ConfigManager {
  private configDir: string;
  private configPath: string;
  private config: CamilleConfig;

  constructor() {
    // Allow override for testing
    this.configDir = process.env.CAMILLE_CONFIG_DIR || path.join(os.homedir(), '.camille');
    this.configPath = path.join(this.configDir, 'config.json');
    this.config = this.loadConfig();
  }

  /**
   * Ensures the configuration directory exists
   */
  private ensureConfigDir(): void {
    if (!fs.existsSync(this.configDir)) {
      fs.mkdirSync(this.configDir, { recursive: true });
    }
  }

  /**
   * Loads configuration from file or creates default
   */
  private loadConfig(): CamilleConfig {
    // Don't create directory when just loading config
    // Load from environment first
    dotenvConfig();
    
    let config: CamilleConfig = { ...DEFAULT_CONFIG };

    // Load from config file if exists (but don't create directory)
    if (fs.existsSync(this.configPath)) {
      try {
        const fileConfig = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
        config = { ...config, ...fileConfig };
      } catch (error) {
        // Don't log error if it's just a missing file
        if (fs.existsSync(this.configDir)) {
          console.error('Error loading config file:', error);
        }
      }
    }

    // Override with environment variables
    if (process.env.OPENAI_API_KEY) {
      config.openaiApiKey = process.env.OPENAI_API_KEY;
    }
    if (process.env.ANTHROPIC_API_KEY) {
      config.anthropicApiKey = process.env.ANTHROPIC_API_KEY;
    }

    return config;
  }

  /**
   * Saves the current configuration to file
   */
  public saveConfig(): void {
    try {
      this.ensureConfigDir();
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
    } catch (error: any) {
      if (error.code === 'EACCES') {
        console.error('\n❌ Permission denied writing to config file');
        console.error('\nThis usually happens when you previously ran setup with sudo.');
        console.error('\nTo fix this:');
        console.error('1. Run: ./fix-permissions.sh');
        console.error('2. Then run: camille setup (WITHOUT sudo)\n');
        throw new Error('Permission denied. See instructions above.');
      }
      throw error;
    }
  }

  /**
   * Gets the API key for the current provider
   * @throws Error if API key is not set and Supastate is not enabled
   */
  public getApiKey(): string {
    // If Supastate is enabled, we don't need local API keys
    if (this.config.supastate?.enabled) {
      return 'supastate-managed';
    }
    
    const provider = this.config.provider || 'openai'; // Default to openai for backward compatibility
    
    if (provider === 'anthropic') {
      if (!this.config.anthropicApiKey) {
        throw new Error('Anthropic API key not configured. Run "camille config set-key <key>" or set ANTHROPIC_API_KEY environment variable.');
      }
      return this.config.anthropicApiKey;
    } else {
      if (!this.config.openaiApiKey) {
        throw new Error('OpenAI API key not configured. Run "camille config set-key <key>" or set OPENAI_API_KEY environment variable.');
      }
      return this.config.openaiApiKey;
    }
  }

  /**
   * Gets the OpenAI API key (for embeddings)
   * @throws Error if API key is not set and Supastate is not enabled
   */
  public getOpenAIApiKey(): string {
    // If Supastate is enabled, embeddings are done server-side
    if (this.config.supastate?.enabled) {
      return 'supastate-managed';
    }
    
    if (!this.config.openaiApiKey) {
      throw new Error('OpenAI API key not configured. Required for embeddings. Run "camille config set-key openai <key>" or set OPENAI_API_KEY environment variable.');
    }
    return this.config.openaiApiKey;
  }

  /**
   * Sets the API key for a provider
   */
  public setApiKey(key: string, provider?: 'anthropic' | 'openai'): void {
    // If no provider specified, use current provider or openai for backward compatibility
    const targetProvider = provider || this.config.provider || 'openai';
    
    if (targetProvider === 'anthropic') {
      this.config.anthropicApiKey = key;
    } else {
      this.config.openaiApiKey = key;
    }
    
    // Also set the provider if explicitly specified
    if (provider) {
      this.config.provider = provider;
    }
    
    this.saveConfig();
  }

  /**
   * Gets the current provider
   */
  public getProvider(): 'anthropic' | 'openai' {
    return this.config.provider || 'openai';
  }

  /**
   * Sets the provider
   */
  public setProvider(provider: 'anthropic' | 'openai'): void {
    this.config.provider = provider;
    this.saveConfig();
  }

  /**
   * Gets the current configuration
   */
  public getConfig(): CamilleConfig {
    return { ...this.config };
  }

  /**
   * Updates configuration values
   */
  public updateConfig(updates: Partial<CamilleConfig>): void {
    this.config = { ...this.config, ...updates };
    this.saveConfig();
  }

  /**
   * Gets the path to custom prompts directory
   */
  public getPromptsDir(): string {
    return path.join(this.configDir, 'prompts');
  }

  /**
   * Gets the config directory
   */
  public getConfigDir(): string {
    return this.configDir;
  }

  /**
   * Gets the config file path
   */
  public getConfigPath(): string {
    return this.configPath;
  }

  /**
   * Loads custom prompt from file
   */
  public loadCustomPrompt(name: string): string | undefined {
    const promptPath = path.join(this.getPromptsDir(), `${name}.txt`);
    if (fs.existsSync(promptPath)) {
      return fs.readFileSync(promptPath, 'utf8');
    }
    return undefined;
  }

  /**
   * Saves custom prompt to file
   */
  public saveCustomPrompt(name: string, content: string): void {
    const promptsDir = this.getPromptsDir();
    if (!fs.existsSync(promptsDir)) {
      fs.mkdirSync(promptsDir, { recursive: true });
    }
    const promptPath = path.join(promptsDir, `${name}.txt`);
    fs.writeFileSync(promptPath, content);
  }
}