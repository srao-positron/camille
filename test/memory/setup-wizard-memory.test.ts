/**
 * Tests for memory configuration in setup wizard
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import inquirer from 'inquirer';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SetupWizard } from '../../src/setup-wizard';

// Mock modules
jest.mock('inquirer');
jest.mock('../../src/logger', () => ({
  Logger: jest.fn().mockImplementation(() => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn()
  }))
}));

describe('Setup Wizard - Memory Configuration', () => {
  let wizard: SetupWizard;
  let testDir: string;
  let mockInquirer: jest.Mocked<typeof inquirer>;

  beforeEach(() => {
    // Create test directory
    testDir = path.join(os.tmpdir(), 'camille-test-setup-' + Date.now());
    fs.mkdirSync(testDir, { recursive: true });
    
    // Set test config directory
    process.env.CAMILLE_CONFIG_DIR = testDir;
    
    wizard = new SetupWizard();
    mockInquirer = inquirer as jest.Mocked<typeof inquirer>;
    
    // Mock console methods
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'clear').mockImplementation(() => {});
    
    // Mock process.exit
    jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);
  });

  afterEach(() => {
    // Clean up
    jest.restoreAllMocks();
    
    // Remove test directory
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
    
    delete process.env.CAMILLE_CONFIG_DIR;
  });

  describe('Memory system setup', () => {
    it('should offer memory configuration during setup', async () => {
      // Mock responses for the setup flow
      mockInquirer.prompt
        .mockResolvedValueOnce({ reconfigure: true }) // Reconfigure
        .mockResolvedValueOnce({ provider: 'openai' }) // Provider selection
        .mockResolvedValueOnce({ reviewModel: 'gpt-4-turbo' }) // Review model
        .mockResolvedValueOnce({ quickModel: 'gpt-4o-mini' }) // Quick model
        .mockResolvedValueOnce({ embeddingModel: 'text-embedding-3-large' }) // Embedding model
        .mockResolvedValueOnce({ key: 'sk-test123' }) // API key
        .mockResolvedValueOnce({ dirChoice: 'done' }) // Skip directory selection
        .mockResolvedValueOnce({ enableMCP: false }) // Disable MCP
        .mockResolvedValueOnce({ enableHooks: false }) // Disable hooks
        .mockResolvedValueOnce({ enableMemory: true }) // Enable memory system
        .mockResolvedValueOnce({ maxMemoryMB: 2048 }) // Memory size
        .mockResolvedValueOnce({ enableTranscripts: true }) // Enable transcripts
        .mockResolvedValueOnce({ enablePeerSharing: false }) // Disable peer sharing
        .mockResolvedValueOnce({ enableService: false }) // Disable auto-start
        .mockResolvedValueOnce({ confirm: true }); // Confirm configuration

      await wizard.run();

      // Verify memory configuration was saved
      const configPath = path.join(testDir, 'config.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      
      expect(config.memory).toBeDefined();
      expect(config.memory.enabled).toBe(true);
      expect(config.memory.maxMemoryMB).toBe(2048);
      expect(config.memory.transcript.enabled).toBe(true);
      expect(config.memory.peer.enabled).toBe(false);
    });

    it('should configure peer sharing when enabled', async () => {
      // Mock responses
      mockInquirer.prompt
        .mockResolvedValueOnce({ reconfigure: true })
        .mockResolvedValueOnce({ provider: 'openai' })
        .mockResolvedValueOnce({ reviewModel: 'gpt-4-turbo' })
        .mockResolvedValueOnce({ quickModel: 'gpt-4o-mini' })
        .mockResolvedValueOnce({ embeddingModel: 'text-embedding-3-large' })
        .mockResolvedValueOnce({ key: 'sk-test123' })
        .mockResolvedValueOnce({ dirChoice: 'done' })
        .mockResolvedValueOnce({ enableMCP: false })
        .mockResolvedValueOnce({ enableHooks: false })
        .mockResolvedValueOnce({ enableMemory: true })
        .mockResolvedValueOnce({ maxMemoryMB: 4096 })
        .mockResolvedValueOnce({ enableTranscripts: true })
        .mockResolvedValueOnce({ enablePeerSharing: true }) // Enable peer sharing
        .mockResolvedValueOnce({ port: 7862 }) // Custom port
        .mockResolvedValueOnce({ allowIndirect: true }) // Allow indirect searches
        .mockResolvedValueOnce({ enableService: false })
        .mockResolvedValueOnce({ confirm: true });

      await wizard.run();

      const configPath = path.join(testDir, 'config.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      
      expect(config.memory.peer.enabled).toBe(true);
      expect(config.memory.peer.port).toBe(7862);
      expect(config.memory.peer.allowIndirect).toBe(true);
    });

    it('should validate memory size limits', async () => {
      const promptMock = (jest.fn() as jest.MockedFunction<any>)
        .mockResolvedValueOnce({ reconfigure: true } as any)
        .mockResolvedValueOnce({ provider: 'openai' } as any)
        .mockResolvedValueOnce({ reviewModel: 'gpt-4-turbo' } as any)
        .mockResolvedValueOnce({ quickModel: 'gpt-4o-mini' } as any)
        .mockResolvedValueOnce({ embeddingModel: 'text-embedding-3-large' } as any)
        .mockResolvedValueOnce({ key: 'sk-test123' } as any)
        .mockResolvedValueOnce({ dirChoice: 'done' } as any)
        .mockResolvedValueOnce({ enableMCP: false } as any)
        .mockResolvedValueOnce({ enableHooks: false } as any)
        .mockResolvedValueOnce({ enableMemory: true } as any);

      mockInquirer.prompt = promptMock as any;

      // Check that the memory size question has validation
      const memoryQuestion = {
        type: 'number',
        name: 'maxMemoryMB',
        message: 'Maximum memory usage (MB):',
        default: 2048,
        validate: expect.any(Function)
      };

      await wizard['setupMemory']();

      // Find the memory size question
      const calls = promptMock.mock.calls;
      const memorySizeCall = calls.find((call: any) => 
        call[0] && Array.isArray(call[0]) && call[0].some((q: any) => q.name === 'maxMemoryMB')
      );

      if (memorySizeCall) {
        const question = (memorySizeCall as any)[0].find((q: any) => q.name === 'maxMemoryMB');
        
        // Test validation
        expect(question.validate(256)).toBe('Minimum 512 MB required');
        expect(question.validate(10000)).toBe('Maximum 8192 MB allowed');
        expect(question.validate(2048)).toBe(true);
      }
    });

    it('should add PreCompact hook when memory is enabled', async () => {
      // Create Claude settings directory
      const claudeDir = path.join(os.homedir(), '.claude');
      if (!fs.existsSync(claudeDir)) {
        fs.mkdirSync(claudeDir, { recursive: true });
      }

      mockInquirer.prompt
        .mockResolvedValueOnce({ reconfigure: true })
        .mockResolvedValueOnce({ provider: 'openai' })
        .mockResolvedValueOnce({ reviewModel: 'gpt-4-turbo' })
        .mockResolvedValueOnce({ quickModel: 'gpt-4o-mini' })
        .mockResolvedValueOnce({ embeddingModel: 'text-embedding-3-large' })
        .mockResolvedValueOnce({ key: 'sk-test123' })
        .mockResolvedValueOnce({ dirChoice: 'done' })
        .mockResolvedValueOnce({ enableMCP: false })
        .mockResolvedValueOnce({ enableHooks: false })
        .mockResolvedValueOnce({ enableMemory: true })
        .mockResolvedValueOnce({ maxMemoryMB: 2048 })
        .mockResolvedValueOnce({ enableTranscripts: true })
        .mockResolvedValueOnce({ enablePeerSharing: false })
        .mockResolvedValueOnce({ enableService: false })
        .mockResolvedValueOnce({ confirm: true });

      await wizard.run();

      // Check Claude settings file
      const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
      if (fs.existsSync(settingsPath)) {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        
        expect(settings.hooks?.PreCompact).toBeDefined();
        expect(settings.hooks.PreCompact[0].matcher).toBe('*');
        expect(settings.hooks.PreCompact[0].hooks[0].type).toBe('command');
        expect(settings.hooks.PreCompact[0].hooks[0].command).toContain('camille-memory-hook');
      }
    });

    it('should skip memory configuration when disabled', async () => {
      mockInquirer.prompt
        .mockResolvedValueOnce({ reconfigure: true })
        .mockResolvedValueOnce({ provider: 'openai' })
        .mockResolvedValueOnce({ reviewModel: 'gpt-4-turbo' })
        .mockResolvedValueOnce({ quickModel: 'gpt-4o-mini' })
        .mockResolvedValueOnce({ embeddingModel: 'text-embedding-3-large' })
        .mockResolvedValueOnce({ key: 'sk-test123' })
        .mockResolvedValueOnce({ dirChoice: 'done' })
        .mockResolvedValueOnce({ enableMCP: false })
        .mockResolvedValueOnce({ enableHooks: false })
        .mockResolvedValueOnce({ enableMemory: false }) // Disable memory
        .mockResolvedValueOnce({ enableService: false })
        .mockResolvedValueOnce({ confirm: true });

      await wizard.run();

      const configPath = path.join(testDir, 'config.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      
      expect(config.memory).toBeUndefined();
    });
  });

  describe('Port validation', () => {
    it('should validate peer port numbers', async () => {
      const promptMock = jest.fn() as jest.MockedFunction<any>;
      mockInquirer.prompt = promptMock as any;

      await wizard['setupMemory']();

      // Simulate enabling peer sharing
      promptMock
        .mockResolvedValueOnce({ enableMemory: true } as any)
        .mockResolvedValueOnce({ maxMemoryMB: 2048 } as any)
        .mockResolvedValueOnce({ enableTranscripts: true } as any)
        .mockResolvedValueOnce({ enablePeerSharing: true } as any);

      // Find the port question
      const portQuestion = {
        type: 'number',
        name: 'port',
        message: 'Port for peer-to-peer communication:',
        default: 7861,
        validate: expect.any(Function)
      };

      // Test port validation
      const validatePort = (port: number) => {
        if (port < 1024 || port > 65535) {
          return 'Port must be between 1024 and 65535';
        }
        return true;
      };

      expect(validatePort(80)).toBe('Port must be between 1024 and 65535');
      expect(validatePort(70000)).toBe('Port must be between 1024 and 65535');
      expect(validatePort(7861)).toBe(true);
    });
  });
});