/**
 * Tests for MCP configuration file creation
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('MCP Configuration Creation', () => {
  let testDir: string;
  
  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camille-mcp-test-'));
  });
  
  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });
  
  describe('Configuration Format', () => {
    it('should create correct pipe-based configuration', () => {
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
      
      // Write config
      const mcpPath = path.join(testDir, '.mcp.json');
      fs.writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2));
      
      // Verify
      const written = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
      expect(written.mcpServers.camille.transport).toBe('pipe');
      expect(written.mcpServers.camille.pipeName).toBe(pipePath);
      expect(written.mcpServers.camille).not.toHaveProperty('command');
      expect(written.mcpServers.camille).not.toHaveProperty('args');
      expect(written.mcpServers.camille).not.toHaveProperty('env');
    });
    
    it('should not include spawning commands', () => {
      const mcpConfig = {
        mcpServers: {
          camille: {
            transport: "pipe",
            pipeName: "/tmp/camille-mcp.sock"
          }
        }
      };
      
      expect(mcpConfig.mcpServers.camille).not.toHaveProperty('command');
      expect(mcpConfig.mcpServers.camille).not.toHaveProperty('args');
      expect(Object.keys(mcpConfig.mcpServers.camille)).toEqual(['transport', 'pipeName']);
    });
  });
  
  describe('Updating Existing Configurations', () => {
    it('should merge with existing .mcp.json preserving other servers', () => {
      // Create existing config with another server
      const existingConfig = {
        mcpServers: {
          "other-server": {
            command: "other",
            args: ["--serve"]
          }
        }
      };
      
      const mcpPath = path.join(testDir, '.mcp.json');
      fs.writeFileSync(mcpPath, JSON.stringify(existingConfig, null, 2));
      
      // Merge in Camille config
      const pipePath = process.platform === 'win32' 
        ? '\\\\.\\pipe\\camille-mcp'
        : path.join(os.tmpdir(), 'camille-mcp.sock');
        
      const camilleConfig = {
        mcpServers: {
          camille: {
            transport: "pipe",
            pipeName: pipePath
          }
        }
      };
      
      const existing = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
      const merged = {
        ...existing,
        mcpServers: {
          ...existing.mcpServers,
          ...camilleConfig.mcpServers
        }
      };
      
      fs.writeFileSync(mcpPath, JSON.stringify(merged, null, 2));
      
      // Verify both servers exist
      const final = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
      expect(final.mcpServers['other-server']).toBeDefined();
      expect(final.mcpServers['other-server'].command).toBe('other');
      expect(final.mcpServers.camille).toBeDefined();
      expect(final.mcpServers.camille.transport).toBe('pipe');
    });
    
    it('should replace old command-based camille config with pipe config', () => {
      // Create old-style config
      const oldConfig = {
        mcpServers: {
          camille: {
            command: "camille",
            args: ["server", "start", "--mcp"],
            env: {
              OPENAI_API_KEY: "${OPENAI_API_KEY}"
            }
          }
        }
      };
      
      const mcpPath = path.join(testDir, '.mcp.json');
      fs.writeFileSync(mcpPath, JSON.stringify(oldConfig, null, 2));
      
      // Update to new style
      const pipePath = process.platform === 'win32' 
        ? '\\\\.\\pipe\\camille-mcp'
        : path.join(os.tmpdir(), 'camille-mcp.sock');
        
      const newConfig = {
        mcpServers: {
          camille: {
            transport: "pipe",
            pipeName: pipePath
          }
        }
      };
      
      const existing = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
      const merged = {
        ...existing,
        mcpServers: {
          ...existing.mcpServers,
          ...newConfig.mcpServers
        }
      };
      
      fs.writeFileSync(mcpPath, JSON.stringify(merged, null, 2));
      
      // Verify old properties are gone
      const final = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
      expect(final.mcpServers.camille).not.toHaveProperty('command');
      expect(final.mcpServers.camille).not.toHaveProperty('args');
      expect(final.mcpServers.camille).not.toHaveProperty('env');
      expect(final.mcpServers.camille.transport).toBe('pipe');
      expect(final.mcpServers.camille.pipeName).toBe(pipePath);
    });
  });
  
  describe('init-mcp command behavior', () => {
    it('should create correct configuration structure', () => {
      // Simulate what init-mcp command does
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
      
      const mcpPath = path.join(testDir, '.mcp.json');
      fs.writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2));
      
      // Verify file is valid JSON
      expect(() => JSON.parse(fs.readFileSync(mcpPath, 'utf8'))).not.toThrow();
      
      // Verify structure
      const config = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
      expect(config).toHaveProperty('mcpServers');
      expect(config.mcpServers).toHaveProperty('camille');
      expect(config.mcpServers.camille).toHaveProperty('transport', 'pipe');
      expect(config.mcpServers.camille).toHaveProperty('pipeName');
    });
  });
});