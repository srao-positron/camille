/**
 * Tests for setup wizard MCP configuration
 */

import { SetupWizard } from '../src/setup-wizard';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import inquirer from 'inquirer';

// Mock dependencies
jest.mock('inquirer');
jest.mock('../src/logger', () => ({
  Logger: jest.fn().mockImplementation(() => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn()
  }))
}));

jest.mock('../src/config', () => ({
  ConfigManager: jest.fn().mockImplementation(() => ({
    getConfig: jest.fn().mockImplementation(() => {
      throw new Error('No config file');  // Simulate no existing config
    }),
    setApiKey: jest.fn(),
    updateConfig: jest.fn()
  }))
}));

jest.mock('../src/openai-client', () => ({
  OpenAIClient: jest.fn().mockImplementation(() => ({
    testConnection: jest.fn().mockResolvedValue(true)
  }))
}));

// Mock console output
const mockConsoleLog = jest.spyOn(console, 'log').mockImplementation();
const mockConsoleError = jest.spyOn(console, 'error').mockImplementation();

// Mock process.exit
const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => {
  throw new Error('process.exit called');
});

describe.skip('Setup Wizard MCP Configuration - Integration Tests', () => {
  let testDir: string;
  let projectDir1: string;
  let projectDir2: string;
  
  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camille-wizard-test-'));
    projectDir1 = path.join(testDir, 'project1');
    projectDir2 = path.join(testDir, 'project2');
    
    fs.mkdirSync(projectDir1, { recursive: true });
    fs.mkdirSync(projectDir2, { recursive: true });
    
    jest.clearAllMocks();
  });
  
  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });
  
  describe('MCP Configuration Generation', () => {
    it('should create .mcp.json with pipe transport', async () => {
      const mockPrompt = inquirer.prompt as unknown as jest.Mock;
      
      // Mock user inputs
      mockPrompt
        .mockResolvedValueOnce({ apiKey: 'test-api-key' })
        .mockResolvedValueOnce({ setupType: 'quick' })
        .mockResolvedValueOnce({ directories: [projectDir1] })
        .mockResolvedValueOnce({ enableMCP: true })
        .mockResolvedValueOnce({ selectedProjects: [projectDir1] })
        .mockResolvedValueOnce({ enableHooks: false })
        .mockResolvedValueOnce({ enableAutoStart: false })
        .mockResolvedValueOnce({ confirm: true });
      
      const wizard = new SetupWizard();
      
      // Capture the private method behavior by checking file output
      try {
        try {
        await wizard.run();
      } catch (error: any) {
        if (error.message !== 'process.exit called') {
          throw error;
        }
      }
      } catch (error: any) {
        // Ignore process.exit error
        if (error.message !== 'process.exit called') {
          throw error;
        }
      }
      
      // Check that .mcp.json was created with pipe configuration
      const mcpPath = path.join(projectDir1, '.mcp.json');
      expect(fs.existsSync(mcpPath)).toBe(true);
      
      const mcpConfig = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
      expect(mcpConfig.mcpServers.camille.transport).toBe('pipe');
      expect(mcpConfig.mcpServers.camille.pipeName).toBeDefined();
      expect(mcpConfig.mcpServers.camille).not.toHaveProperty('command');
      expect(mcpConfig.mcpServers.camille).not.toHaveProperty('args');
      expect(mcpConfig.mcpServers.camille).not.toHaveProperty('env');
    });
    
    it('should use correct pipe path for platform', async () => {
      const mockPrompt = inquirer.prompt as unknown as jest.Mock;
      
      mockPrompt.mockResolvedValueOnce({ existingConfig: false })
        .mockResolvedValueOnce({ apiKey: 'test-api-key' })
        .mockResolvedValueOnce({ setupType: 'quick' })
        .mockResolvedValueOnce({ directories: [projectDir1] })
        .mockResolvedValueOnce({ enableMCP: true })
        .mockResolvedValueOnce({ selectedProjects: [projectDir1] })
        .mockResolvedValueOnce({ enableHooks: false })
        .mockResolvedValueOnce({ enableAutoStart: false })
        .mockResolvedValueOnce({ confirm: true });
      
      const wizard = new SetupWizard();
      try {
        await wizard.run();
      } catch (error: any) {
        if (error.message !== 'process.exit called') {
          throw error;
        }
      }
      
      const mcpPath = path.join(projectDir1, '.mcp.json');
      const mcpConfig = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
      
      if (process.platform === 'win32') {
        expect(mcpConfig.mcpServers.camille.pipeName).toBe('\\\\.\\pipe\\camille-mcp');
      } else {
        expect(mcpConfig.mcpServers.camille.pipeName).toBe(path.join(os.tmpdir(), 'camille-mcp.sock'));
      }
    });
    
    it('should create .mcp.json in multiple projects', async () => {
      const mockPrompt = inquirer.prompt as unknown as jest.Mock;
      
      mockPrompt.mockResolvedValueOnce({ existingConfig: false })
        .mockResolvedValueOnce({ apiKey: 'test-api-key' })
        .mockResolvedValueOnce({ setupType: 'quick' })
        .mockResolvedValueOnce({ directories: [projectDir1, projectDir2] })
        .mockResolvedValueOnce({ enableMCP: true })
        .mockResolvedValueOnce({ selectedProjects: [projectDir1, projectDir2] })
        .mockResolvedValueOnce({ enableHooks: false })
        .mockResolvedValueOnce({ enableAutoStart: false })
        .mockResolvedValueOnce({ confirm: true });
      
      const wizard = new SetupWizard();
      try {
        await wizard.run();
      } catch (error: any) {
        if (error.message !== 'process.exit called') {
          throw error;
        }
      }
      
      // Check both projects have .mcp.json
      const mcp1 = path.join(projectDir1, '.mcp.json');
      const mcp2 = path.join(projectDir2, '.mcp.json');
      
      expect(fs.existsSync(mcp1)).toBe(true);
      expect(fs.existsSync(mcp2)).toBe(true);
      
      // Both should have same pipe configuration
      const config1 = JSON.parse(fs.readFileSync(mcp1, 'utf8'));
      const config2 = JSON.parse(fs.readFileSync(mcp2, 'utf8'));
      
      expect(config1.mcpServers.camille.pipeName).toBe(config2.mcpServers.camille.pipeName);
    });
  });
  
  describe('Existing MCP Configuration', () => {
    it('should prompt to update existing .mcp.json', async () => {
      // Create existing .mcp.json with old format
      const existingMcp = {
        mcpServers: {
          camille: {
            command: "camille",
            args: ["server", "start", "--mcp"]
          }
        }
      };
      
      fs.writeFileSync(
        path.join(projectDir1, '.mcp.json'),
        JSON.stringify(existingMcp, null, 2)
      );
      
      const mockPrompt = inquirer.prompt as unknown as jest.Mock;
      
      mockPrompt.mockResolvedValueOnce({ existingConfig: false })
        .mockResolvedValueOnce({ apiKey: 'test-api-key' })
        .mockResolvedValueOnce({ setupType: 'quick' })
        .mockResolvedValueOnce({ directories: [projectDir1] })
        .mockResolvedValueOnce({ enableMCP: true })
        .mockResolvedValueOnce({ selectedProjects: [projectDir1] })
        .mockResolvedValueOnce({ overwrite: true }) // Prompt for overwrite
        .mockResolvedValueOnce({ enableHooks: false })
        .mockResolvedValueOnce({ enableAutoStart: false })
        .mockResolvedValueOnce({ confirm: true });
      
      const wizard = new SetupWizard();
      try {
        await wizard.run();
      } catch (error: any) {
        if (error.message !== 'process.exit called') {
          throw error;
        }
      }
      
      // Check that .mcp.json was updated
      const mcpConfig = JSON.parse(fs.readFileSync(path.join(projectDir1, '.mcp.json'), 'utf8'));
      expect(mcpConfig.mcpServers.camille.transport).toBe('pipe');
      expect(mcpConfig.mcpServers.camille).not.toHaveProperty('command');
    });
    
    it('should skip update if user declines', async () => {
      const existingMcp = {
        mcpServers: {
          other: { command: "other-server" }
        }
      };
      
      fs.writeFileSync(
        path.join(projectDir1, '.mcp.json'),
        JSON.stringify(existingMcp, null, 2)
      );
      
      const mockPrompt = inquirer.prompt as unknown as jest.Mock;
      
      mockPrompt.mockResolvedValueOnce({ existingConfig: false })
        .mockResolvedValueOnce({ apiKey: 'test-api-key' })
        .mockResolvedValueOnce({ setupType: 'quick' })
        .mockResolvedValueOnce({ directories: [projectDir1] })
        .mockResolvedValueOnce({ enableMCP: true })
        .mockResolvedValueOnce({ selectedProjects: [projectDir1] })
        .mockResolvedValueOnce({ overwrite: false }) // Decline overwrite
        .mockResolvedValueOnce({ enableHooks: false })
        .mockResolvedValueOnce({ enableAutoStart: false })
        .mockResolvedValueOnce({ confirm: true });
      
      const wizard = new SetupWizard();
      try {
        await wizard.run();
      } catch (error: any) {
        if (error.message !== 'process.exit called') {
          throw error;
        }
      }
      
      // Check that .mcp.json was not changed
      const mcpConfig = JSON.parse(fs.readFileSync(path.join(projectDir1, '.mcp.json'), 'utf8'));
      expect(mcpConfig.mcpServers).not.toHaveProperty('camille');
      expect(mcpConfig.mcpServers.other).toBeDefined();
    });
  });
  
  describe('Success Messages', () => {
    it('should explain central service architecture', async () => {
      const mockPrompt = inquirer.prompt as unknown as jest.Mock;
      
      mockPrompt.mockResolvedValueOnce({ existingConfig: false })
        .mockResolvedValueOnce({ apiKey: 'test-api-key' })
        .mockResolvedValueOnce({ setupType: 'quick' })
        .mockResolvedValueOnce({ directories: [projectDir1] })
        .mockResolvedValueOnce({ enableMCP: true })
        .mockResolvedValueOnce({ selectedProjects: [projectDir1] })
        .mockResolvedValueOnce({ enableHooks: false })
        .mockResolvedValueOnce({ enableAutoStart: false })
        .mockResolvedValueOnce({ confirm: true });
      
      const wizard = new SetupWizard();
      try {
        await wizard.run();
      } catch (error: any) {
        if (error.message !== 'process.exit called') {
          throw error;
        }
      }
      
      // Check that success message mentions central service
      const logCalls = mockConsoleLog.mock.calls.flat().join('\n');
      expect(logCalls).toContain('central Camille service');
      expect(logCalls).toContain('No new servers will be spawned');
    });
  });
});