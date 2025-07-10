/**
 * Integration tests for Camille
 * Tests the full flow with real OpenAI API calls
 */

import { CamilleServer, ServerManager } from '../src/server';
import { CamilleMCPServer } from '../src/mcp-server';
import { ConfigManager } from '../src/config';
import { runHook } from '../src/hook';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';

// Only run these tests if OPENAI_API_KEY is provided
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.TEST_OPENAI_API_KEY;
const describeIf = OPENAI_API_KEY ? describe : describe.skip;

describeIf('Integration Tests (requires OpenAI API key)', () => {
  let testDir: string;
  let configManager: ConfigManager;

  beforeAll(() => {
    // Set up test environment
    testDir = path.join(os.tmpdir(), 'camille-integration-test');
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
    fs.mkdirSync(testDir, { recursive: true });

    // Set up config with test API key
    configManager = new ConfigManager();
    if (OPENAI_API_KEY) {
      configManager.setApiKey(OPENAI_API_KEY);
    }
  });

  afterAll(() => {
    // Clean up
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  describe('Server Mode', () => {
    let server: CamilleServer;

    beforeEach(async () => {
      // Create test files
      const srcDir = path.join(testDir, 'src');
      fs.mkdirSync(srcDir, { recursive: true });
      
      fs.writeFileSync(
        path.join(srcDir, 'index.js'),
        `// Main application entry point
function main() {
  console.log('Hello, world!');
}

module.exports = { main };`
      );

      fs.writeFileSync(
        path.join(srcDir, 'utils.js'),
        `// Utility functions
function formatDate(date) {
  return date.toISOString();
}

function parseJSON(str) {
  return JSON.parse(str);
}

module.exports = { formatDate, parseJSON };`
      );
    });

    afterEach(async () => {
      await ServerManager.stop();
    });

    it('should index files and perform search', async () => {
      server = await ServerManager.start(testDir);

      // Wait for indexing to complete
      await new Promise(resolve => setTimeout(resolve, 5000));

      const index = server.getEmbeddingsIndex();
      expect(index.isIndexReady()).toBe(true);
      expect(index.getIndexSize()).toBeGreaterThan(0);

      // Perform a search
      const openaiClient = new (require('../src/openai-client').OpenAIClient)(
        OPENAI_API_KEY,
        configManager.getConfig(),
        testDir
      );
      
      const queryEmbedding = await openaiClient.generateEmbedding('date formatting utilities');
      const results = index.search(queryEmbedding, 5);

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].path).toContain('utils.js');
    }, 30000);

    it('should detect file changes and re-index', async () => {
      server = await ServerManager.start(testDir);
      
      // Wait for initial indexing
      await new Promise(resolve => setTimeout(resolve, 5000));

      const utilsPath = path.join(testDir, 'src', 'utils.js');
      const newContent = `// Updated utility functions
function formatDate(date) {
  return new Intl.DateTimeFormat('en-US').format(date);
}

function parseJSON(str) {
  try {
    return JSON.parse(str);
  } catch (e) {
    return null;
  }
}

module.exports = { formatDate, parseJSON };`;

      fs.writeFileSync(utilsPath, newContent);

      // Wait for re-indexing
      await new Promise(resolve => setTimeout(resolve, 3000));

      const index = server.getEmbeddingsIndex();
      expect(index.needsReindex(utilsPath)).toBe(false);
    }, 20000);
  });

  describe('Hook Integration', () => {
    it('should validate secure code changes', async () => {
      const hookProcess = spawn('node', [path.join(__dirname, '..', 'dist', 'cli.js'), 'hook'], {
        env: { ...process.env, OPENAI_API_KEY }
      });

      const input = JSON.stringify({
        session_id: 'test-session',
        transcript_path: '/tmp/test',
        hook_event_name: 'PreToolUse',
        tool: {
          name: 'Edit',
          input: {
            file_path: '/test/secure.js',
            old_string: 'var data = getUserInput();',
            new_string: 'const data = sanitizeInput(getUserInput());'
          }
        }
      });

      hookProcess.stdin.write(input);
      hookProcess.stdin.end();

      const output = await new Promise<string>((resolve, reject) => {
        let data = '';
        hookProcess.stdout.on('data', chunk => data += chunk);
        hookProcess.on('close', code => {
          if (code === 0) resolve(data);
          else reject(new Error(`Hook exited with code ${code}`));
        });
      });

      const result = JSON.parse(output);
      expect(result.continue).toBe(true);
      expect(result.decision).toBe('approve');
    }, 20000);

    it('should block insecure code changes', async () => {
      const hookProcess = spawn('node', [path.join(__dirname, '..', 'dist', 'cli.js'), 'hook'], {
        env: { ...process.env, OPENAI_API_KEY }
      });

      const input = JSON.stringify({
        session_id: 'test-session',
        transcript_path: '/tmp/test',
        hook_event_name: 'PreToolUse',
        tool: {
          name: 'Write',
          input: {
            file_path: '/test/vulnerable.js',
            content: `// Vulnerable code
const userInput = req.query.input;
const result = eval(userInput); // Direct eval of user input
response.send(result);`
          }
        }
      });

      hookProcess.stdin.write(input);
      hookProcess.stdin.end();

      const result = await new Promise<any>((resolve, reject) => {
        let data = '';
        hookProcess.stdout.on('data', chunk => data += chunk);
        hookProcess.on('close', code => {
          try {
            resolve({ code, output: JSON.parse(data) });
          } catch (e) {
            reject(e);
          }
        });
      });

      expect(result.code).toBe(2); // Blocking error
      expect(result.output.continue).toBe(false);
      expect(result.output.decision).toBe('block');
      expect(result.output.reason).toContain('Security');
    }, 20000);
  });

  describe('MCP Server Integration', () => {
    let mcpServer: CamilleMCPServer;
    let server: CamilleServer;

    beforeEach(async () => {
      // Start main server first
      server = await ServerManager.start(testDir);
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Start MCP server
      mcpServer = new CamilleMCPServer();
    });

    afterEach(async () => {
      await ServerManager.stop();
    });

    it('should handle search requests through MCP', async () => {
      // Simulate MCP tool call
      const searchResult = await mcpServer['handleSearchCode']({
        query: 'utility functions for formatting',
        limit: 5
      });

      expect(searchResult.error).toBeUndefined();
      expect(searchResult.results).toBeDefined();
      expect(Array.isArray(searchResult.results)).toBe(true);
    }, 20000);

    it('should validate changes through MCP', async () => {
      const validationResult = await mcpServer['handleValidateChanges']({
        filePath: '/test/api.js',
        changes: `
function handleRequest(req, res) {
  const data = req.body;
  // Validate input
  if (!data || typeof data !== 'object') {
    return res.status(400).json({ error: 'Invalid input' });
  }
  // Process safely
  const result = processData(data);
  res.json(result);
}`,
        changeType: 'create'
      });

      expect(validationResult.error).toBeUndefined();
      expect(validationResult.approved).toBeDefined();
      expect(validationResult.details).toBeDefined();
    }, 20000);
  });
});