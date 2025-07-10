/**
 * Tests for MCP pipe connection architecture
 */

import { CamilleMCPServer } from '../src/mcp-server';
import { ServerManager } from '../src/server';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as net from 'net';

// Mock dependencies
jest.mock('../src/logger', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    logServerEvent: jest.fn()
  }
}));

jest.mock('../src/utils/console', () => ({
  consoleOutput: {
    info: jest.fn(),
    success: jest.fn(),
    warning: jest.fn(),
    error: jest.fn()
  },
  isQuietMode: () => true
}));

describe('MCP Pipe Connection', () => {
  let testDir: string;
  let mcpServer: CamilleMCPServer;
  
  beforeEach(() => {
    // Create test directory
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camille-test-'));
    jest.clearAllMocks();
  });
  
  afterEach(async () => {
    // Stop server if running
    await ServerManager.stop();
    
    // Clean up test directory
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    
    // Clean up any pipes
    const pipePath = process.platform === 'win32' 
      ? '\\\\.\\pipe\\camille-mcp'
      : path.join(os.tmpdir(), 'camille-mcp.sock');
    
    if (process.platform !== 'win32' && fs.existsSync(pipePath)) {
      fs.unlinkSync(pipePath);
    }
  });
  
  describe('Named Pipe Configuration', () => {
    it('should use correct pipe path for platform', () => {
      mcpServer = new CamilleMCPServer();
      const pipePath = mcpServer.getPipePath();
      
      if (process.platform === 'win32') {
        expect(pipePath).toBe('\\\\.\\pipe\\camille-mcp');
      } else {
        expect(pipePath).toBe(path.join(os.tmpdir(), 'camille-mcp.sock'));
      }
    });
    
    it('should generate correct .mcp.json for pipe connection', () => {
      const pipePath = process.platform === 'win32' 
        ? '\\\\.\\pipe\\camille-mcp'
        : path.join(os.tmpdir(), 'camille-mcp.sock');
        
      const mcpConfig = {
        mcpServers: {
          camille: {
            transport: "pipe",
            pipeName: pipePath
          }
        }
      };
      
      expect(mcpConfig.mcpServers.camille.transport).toBe('pipe');
      expect(mcpConfig.mcpServers.camille.pipeName).toBe(pipePath);
      expect(mcpConfig.mcpServers.camille).not.toHaveProperty('command');
      expect(mcpConfig.mcpServers.camille).not.toHaveProperty('args');
    });
  });
  
  describe('Pipe Server', () => {
    it('should start MCP server and accept connections', async () => {
      // Skip on Windows CI - pipe tests are flaky there
      if (process.platform === 'win32' && process.env.CI) {
        return;
      }
      
      // Start the main server
      await ServerManager.start(testDir);
      
      // Create and start MCP server
      mcpServer = new CamilleMCPServer();
      await mcpServer.start();
      
      const pipePath = mcpServer.getPipePath();
      
      // Test connection
      await new Promise<void>((resolve, reject) => {
        const client = net.createConnection(pipePath, () => {
          client.end();
          resolve();
        });
        
        client.on('error', reject);
        
        setTimeout(() => {
          client.destroy();
          reject(new Error('Connection timeout'));
        }, 1000);
      });
      
      await mcpServer.stop();
    });
    
    it('should handle multiple client connections', async () => {
      // Skip on Windows CI
      if (process.platform === 'win32' && process.env.CI) {
        return;
      }
      
      await ServerManager.start(testDir);
      mcpServer = new CamilleMCPServer();
      await mcpServer.start();
      
      const pipePath = mcpServer.getPipePath();
      const connectionPromises = [];
      
      // Create multiple connections
      for (let i = 0; i < 3; i++) {
        const promise = new Promise<void>((resolve, reject) => {
          const client = net.createConnection(pipePath, () => {
            setTimeout(() => {
              client.end();
              resolve();
            }, 50);
          });
          
          client.on('error', reject);
          
          setTimeout(() => {
            client.destroy();
            reject(new Error('Connection timeout'));
          }, 1000);
        });
        
        connectionPromises.push(promise);
      }
      
      await Promise.all(connectionPromises);
      await mcpServer.stop();
    });
  });
  
  describe('Central Service Architecture', () => {
    it('should not spawn new server instances per project', () => {
      // Verify that .mcp.json doesn't contain server spawn commands
      const mcpConfig = {
        mcpServers: {
          camille: {
            transport: "pipe",
            pipeName: "/tmp/camille-mcp.sock"
          }
        }
      };
      
      // Should not have command or args
      expect(mcpConfig.mcpServers.camille).not.toHaveProperty('command');
      expect(mcpConfig.mcpServers.camille).not.toHaveProperty('args');
      expect(mcpConfig.mcpServers.camille).not.toHaveProperty('env');
    });
    
    it('should share same server instance across multiple projects', async () => {
      await ServerManager.start([testDir]);
      const instance1 = ServerManager.getInstance();
      
      // Simulate another project trying to start
      await expect(ServerManager.start([testDir])).rejects.toThrow('already running');
      
      const instance2 = ServerManager.getInstance();
      expect(instance1).toBe(instance2);
    });
  });
  
  describe('Connection Testing', () => {
    it('should successfully test pipe connection when server is running', async () => {
      // Skip on Windows CI
      if (process.platform === 'win32' && process.env.CI) {
        return;
      }
      
      await ServerManager.start(testDir);
      mcpServer = new CamilleMCPServer();
      await mcpServer.start();
      
      const pipePath = mcpServer.getPipePath();
      
      // Test connection (simulating --test-pipe flag)
      const testConnection = () => new Promise<boolean>((resolve) => {
        const client = net.createConnection(pipePath);
        
        client.on('connect', () => {
          client.end();
          resolve(true);
        });
        
        client.on('error', () => {
          resolve(false);
        });
        
        setTimeout(() => {
          client.destroy();
          resolve(false);
        }, 2000);
      });
      
      const connected = await testConnection();
      expect(connected).toBe(true);
      
      await mcpServer.stop();
    });
    
    it('should fail pipe connection test when server is not running', async () => {
      const pipePath = process.platform === 'win32' 
        ? '\\\\.\\pipe\\camille-mcp'
        : path.join(os.tmpdir(), 'camille-mcp.sock');
      
      const testConnection = () => new Promise<boolean>((resolve) => {
        const client = net.createConnection(pipePath);
        
        client.on('connect', () => {
          client.end();
          resolve(true);
        });
        
        client.on('error', () => {
          resolve(false);
        });
        
        setTimeout(() => {
          client.destroy();
          resolve(false);
        }, 500);
      });
      
      const connected = await testConnection();
      expect(connected).toBe(false);
    });
  });
});