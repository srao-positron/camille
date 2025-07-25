/**
 * Tests for configuration management
 */

import { ConfigManager } from '../src/config';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('ConfigManager', () => {
  let configManager: ConfigManager;
  const testConfigDir = path.join(os.tmpdir(), '.camille-test');
  
  beforeEach(() => {
    // Clean up test directory
    if (fs.existsSync(testConfigDir)) {
      fs.rmSync(testConfigDir, { recursive: true });
    }
    
    // Set test environment variables
    process.env.CAMILLE_CONFIG_DIR = testConfigDir;
    process.env.OPENAI_API_KEY = 'test-key-from-env';
    
    configManager = new ConfigManager();
  });

  afterEach(() => {
    // Clean up
    if (fs.existsSync(testConfigDir)) {
      fs.rmSync(testConfigDir, { recursive: true });
    }
    delete process.env.OPENAI_API_KEY;
    delete process.env.CAMILLE_CONFIG_DIR;
  });

  describe('initialization', () => {
    it('should not create config directory until saving', () => {
      expect(fs.existsSync(testConfigDir)).toBe(false);
    });

    it('should load OpenAI API key from environment variable', () => {
      // Since default provider is anthropic, switch to OpenAI to test
      configManager.setProvider('openai');
      expect(configManager.getApiKey()).toBe('test-key-from-env');
    });

    it('should use default configuration values', () => {
      const config = configManager.getConfig();
      expect(config.provider).toBe('anthropic');
      expect(config.models.review).toBe('claude-opus-4-20250514');
      expect(config.models.quick).toBe('claude-3-5-haiku-20241022');
      expect(config.models.embedding).toBe('text-embedding-3-large');
      expect(config.temperature).toBe(0.1);
      expect(config.maxTokens).toBe(4000);
      expect(config.maxFileSize).toBe(200000);
      expect(config.maxIndexFileSize).toBe(500000);
      expect(config.cacheToDisk).toBe(true);
      expect(config.expansiveReview).toBe(true);
    });
  });

  describe('setApiKey', () => {
    it('should save API key to config file', () => {
      configManager.setApiKey('new-test-key');
      
      const configPath = path.join(testConfigDir, 'config.json');
      expect(fs.existsSync(configPath)).toBe(true);
      
      const savedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      expect(savedConfig.openaiApiKey).toBe('new-test-key');
    });

    it('should update in-memory configuration', () => {
      configManager.setApiKey('new-test-key');
      expect(configManager.getApiKey()).toBe('new-test-key');
    });
  });

  describe('updateConfig', () => {
    it('should update configuration values', () => {
      configManager.updateConfig({
        temperature: 0.5,
        cacheToDisk: true,
        models: {
          review: 'gpt-4',
          quick: 'gpt-3.5-turbo',
          embedding: 'text-embedding-ada-002'
        }
      });

      const config = configManager.getConfig();
      expect(config.temperature).toBe(0.5);
      expect(config.cacheToDisk).toBe(true);
      expect(config.models.review).toBe('gpt-4');
    });

    it('should persist updates to file', () => {
      configManager.updateConfig({ temperature: 0.7 });
      
      // Create new instance to test persistence
      const newConfigManager = new ConfigManager();
      const config = newConfigManager.getConfig();
      expect(config.temperature).toBe(0.7);
    });
  });

  describe('custom prompts', () => {
    it('should save custom prompts', () => {
      const customPrompt = 'This is a custom system prompt';
      configManager.saveCustomPrompt('system', customPrompt);
      
      const promptPath = path.join(testConfigDir, 'prompts', 'system.txt');
      expect(fs.existsSync(promptPath)).toBe(true);
      expect(fs.readFileSync(promptPath, 'utf8')).toBe(customPrompt);
    });

    it('should load custom prompts', () => {
      const customPrompt = 'This is a custom review prompt';
      configManager.saveCustomPrompt('review', customPrompt);
      
      const loaded = configManager.loadCustomPrompt('review');
      expect(loaded).toBe(customPrompt);
    });

    it('should return undefined for non-existent prompts', () => {
      const loaded = configManager.loadCustomPrompt('non-existent');
      expect(loaded).toBeUndefined();
    });
  });

  describe('error handling', () => {
    it('should throw error when API key is not set', () => {
      delete process.env.OPENAI_API_KEY;
      const newConfigManager = new ConfigManager();
      
      expect(() => newConfigManager.getApiKey()).toThrow('OpenAI API key not configured');
    });
  });
});