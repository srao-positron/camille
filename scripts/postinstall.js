#!/usr/bin/env node

/**
 * Post-install script for Camille
 * Sets up hook integration with Claude Code
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

console.log('🔧 Setting up Camille...');

// Create config directory
const configDir = path.join(os.homedir(), '.camille');
if (!fs.existsSync(configDir)) {
  fs.mkdirSync(configDir, { recursive: true });
  console.log('✅ Created configuration directory');
}

// Create prompts directory
const promptsDir = path.join(configDir, 'prompts');
if (!fs.existsSync(promptsDir)) {
  fs.mkdirSync(promptsDir, { recursive: true });
  console.log('✅ Created prompts directory');
}

// Instructions for Claude Code hook setup
console.log('\n📋 To use Camille as a Claude Code hook:');
console.log('\n1. First, set your OpenAI API key:');
console.log('   camille set-key YOUR_OPENAI_API_KEY');
console.log('\n2. Add this to your Claude Code settings:');
console.log(`
{
  "hooks": {
    "preToolUse": [
      {
        "command": "camille hook",
        "matchers": {
          "tools": ["Edit", "MultiEdit", "Write"]
        }
      }
    ]
  }
}
`);

console.log('\n3. For MCP integration, start the server with:');
console.log('   camille server start --mcp');

console.log('\n✨ Setup complete! Run "camille help" for more information.');