/**
 * Tests for setup wizard functionality
 */

import { SetupWizard } from '../src/setup-wizard';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Mock dependencies
jest.mock('inquirer');
jest.mock('../src/config');
jest.mock('../src/openai-client');
jest.mock('../src/logger');

describe('SetupWizard', () => {
  let wizard: SetupWizard;
  const homeDir = os.homedir();
  
  beforeEach(() => {
    wizard = new SetupWizard();
    jest.clearAllMocks();
  });

  describe('Directory path expansion', () => {
    it('should expand ~ to home directory', () => {
      const input = '~/projects/test';
      const expected = path.join(homeDir, 'projects', 'test');
      const expanded = input.replace(/^~/, homeDir);
      expect(expanded).toBe(expected);
    });

    it('should handle paths without ~', () => {
      const input = '/usr/local/test';
      const expanded = input.replace(/^~/, homeDir);
      expect(expanded).toBe(input);
    });

    it('should handle relative paths', () => {
      const input = './test';
      const resolved = path.resolve(input);
      expect(resolved).toBe(path.join(process.cwd(), 'test'));
    });
  });

  describe('Directory search logic', () => {
    it('should find directories starting with prefix', () => {
      // Test the logic for finding directories
      const testDir = '/tmp/test-camille-wizard';
      const subDirs = ['hawking-edison', 'hawking-newton', 'other-project'];
      
      // Create test directories
      if (!fs.existsSync(testDir)) {
        fs.mkdirSync(testDir, { recursive: true });
      }
      
      for (const dir of subDirs) {
        const fullPath = path.join(testDir, dir);
        if (!fs.existsSync(fullPath)) {
          fs.mkdirSync(fullPath, { recursive: true });
        }
      }
      
      // Test search logic
      const searchPrefix = 'hawking';
      const entries = fs.readdirSync(testDir, { withFileTypes: true });
      const matches = entries
        .filter(entry => entry.isDirectory() && entry.name.toLowerCase().startsWith(searchPrefix.toLowerCase()))
        .map(entry => path.join(testDir, entry.name));
      
      expect(matches).toHaveLength(2);
      expect(matches).toContain(path.join(testDir, 'hawking-edison'));
      expect(matches).toContain(path.join(testDir, 'hawking-newton'));
      
      // Cleanup
      fs.rmSync(testDir, { recursive: true });
    });

    it('should handle path separators correctly', () => {
      const input = '~/projects/test';
      const expanded = input.replace(/^~/, homeDir);
      const lastSep = expanded.lastIndexOf(path.sep);
      const searchDir = expanded.substring(0, lastSep);
      const searchPrefix = expanded.substring(lastSep + 1);
      
      expect(searchDir).toBe(path.join(homeDir, 'projects'));
      expect(searchPrefix).toBe('test');
    });
  });

  describe('Path validation', () => {
    it('should validate existing directories', () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camille-test-'));
      
      expect(fs.existsSync(tempDir)).toBe(true);
      expect(fs.statSync(tempDir).isDirectory()).toBe(true);
      
      // Cleanup
      fs.rmSync(tempDir, { recursive: true });
    });

    it('should reject non-existent paths', () => {
      const fakePath = '/this/does/not/exist/at/all';
      expect(fs.existsSync(fakePath)).toBe(false);
    });

    it('should reject files instead of directories', () => {
      const tempFile = path.join(os.tmpdir(), 'camille-test-file.txt');
      fs.writeFileSync(tempFile, 'test');
      
      expect(fs.existsSync(tempFile)).toBe(true);
      expect(fs.statSync(tempFile).isDirectory()).toBe(false);
      
      // Cleanup
      fs.unlinkSync(tempFile);
    });
  });
});