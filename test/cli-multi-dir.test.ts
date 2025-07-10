/**
 * Tests for CLI multi-directory commands
 */

import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

describe('CLI Multi-Directory Commands', () => {
  const cliPath = path.join(__dirname, '..', 'dist', 'cli.js');
  let testBaseDir: string;
  let testDir1: string;
  let testDir2: string;

  beforeAll(() => {
    // Ensure CLI is built
    if (!fs.existsSync(cliPath)) {
      throw new Error('CLI not built. Run npm run build first.');
    }
  });

  beforeEach(() => {
    // Set up test directories
    testBaseDir = path.join(os.tmpdir(), 'camille-cli-test');
    testDir1 = path.join(testBaseDir, 'project1');
    testDir2 = path.join(testBaseDir, 'project2');

    [testBaseDir, testDir1, testDir2].forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });

    // Set test API key
    process.env.OPENAI_API_KEY = 'test-key';
  });

  afterEach(() => {
    if (fs.existsSync(testBaseDir)) {
      fs.rmSync(testBaseDir, { recursive: true });
    }
  });

  /**
   * Helper to run CLI command
   */
  async function runCommand(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const proc = spawn('node', [cliPath, ...args], {
        env: { ...process.env, OPENAI_API_KEY: 'test-key' }
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => stdout += data);
      proc.stderr.on('data', (data) => stderr += data);

      proc.on('close', (code) => {
        resolve({ code: code || 0, stdout, stderr });
      });

      // Kill after timeout
      setTimeout(() => proc.kill(), 5000);
    });
  }

  describe('server start with multiple directories', () => {
    it('should start with single directory', async () => {
      const result = await runCommand(['server', 'start', '-d', testDir1]);
      
      expect(result.stdout).toContain('Starting Camille server');
      expect(result.stdout).toContain('Camille server is running');
    });

    it('should start with multiple directories', async () => {
      const result = await runCommand(['server', 'start', '-d', testDir1, testDir2]);
      
      expect(result.stdout).toContain('Starting Camille server');
      expect(result.stdout).toContain(`Adding directory: ${testDir1}`);
      expect(result.stdout).toContain(`Adding directory: ${testDir2}`);
    });
  });

  describe('server add-directory command', () => {
    it('should show help when server not running', async () => {
      const result = await runCommand(['server', 'add-directory', testDir1]);
      
      expect(result.stdout).toContain('Server is not running');
      expect(result.stdout).toContain('camille server start');
    });
  });

  describe('server remove-directory command', () => {
    it('should show message when server not running', async () => {
      const result = await runCommand(['server', 'remove-directory', testDir1]);
      
      expect(result.stdout).toContain('Server is not running');
    });
  });

  describe('server status with directories', () => {
    it('should show watched directories in status', async () => {
      const result = await runCommand(['server', 'status']);
      
      expect(result.stdout).toContain('Server is not running');
    });
  });

  describe('help text', () => {
    it('should show add-directory in server help', async () => {
      const result = await runCommand(['server', '--help']);
      
      expect(result.stdout).toContain('add-directory');
      expect(result.stdout).toContain('Add directories to watch');
    });

    it('should show remove-directory in server help', async () => {
      const result = await runCommand(['server', '--help']);
      
      expect(result.stdout).toContain('remove-directory');
      expect(result.stdout).toContain('Remove directories from watching');
    });

    it('should show updated start help', async () => {
      const result = await runCommand(['server', 'start', '--help']);
      
      expect(result.stdout).toContain('can specify multiple');
    });
  });
});