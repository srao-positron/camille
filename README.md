# Camille

An intelligent code compliance checker and embedding search tool for Claude Code that uses OpenAI to validate code changes against project rules, security best practices, and architectural decisions.

## Features

- **🔒 Security-First Code Review**: Automatically reviews code changes for security vulnerabilities including injection attacks, XSS, authentication flaws, and more
- **📋 Compliance Checking**: Validates code against your project's CLAUDE.md and development rules
- **🔍 Semantic Code Search**: Uses OpenAI embeddings to search your codebase with natural language queries
- **🪝 Claude Code Hook Integration**: Seamlessly integrates with Claude Code to review changes before they're applied
- **🤖 MCP Server**: Provides tools to Claude for searching code and validating changes
- **📁 Smart File Watching**: Automatically indexes new and changed files in real-time
- **⚡ Performance Optimized**: Uses GPT-4o mini for routine checks and GPT-4 Turbo for complex analysis

## Installation

### From npm (when published)
```bash
npm install -g camille
```

### From GitHub (before npm publication)
```bash
git clone https://github.com/yourusername/camille.git
cd camille
npm install
npm run build
npm link
```

## Quick Start

### 1. Set your OpenAI API key
```bash
camille set-key YOUR_OPENAI_API_KEY
```

### 2. Configure Claude Code hooks
Add this to your Claude Code settings:
```json
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
```

### 3. Start the server (optional, for search functionality)
```bash
camille server start --mcp
```

## Usage

### As a Claude Code Hook

Once configured, Camille automatically reviews all code changes made by Claude. It will:
- Block changes with security vulnerabilities
- Flag compliance violations
- Suggest improvements for code quality

### Server Mode

Start the server to enable code search and continuous indexing:

```bash
# Start server in current directory
camille server start

# Start server with MCP integration
camille server start --mcp

# Start server in specific directory
camille server start --directory /path/to/project

# Check server status
camille server status

# Stop server
camille server stop
```

### MCP Integration

When started with `--mcp`, Camille provides these tools to Claude:

#### `camille_search_code`
Search for code using natural language:
- "authentication and user login"
- "database connection handling"
- "error logging implementation"

#### `camille_validate_changes`
Validate code changes before applying them:
- Checks for security vulnerabilities
- Ensures compliance with project rules
- Suggests improvements

#### `camille_status`
Check if the server is running and index is ready.

### Configuration

View current configuration:
```bash
camille config show
```

Update configuration:
```bash
# Change review model
camille config set models.review gpt-4

# Enable disk caching for embeddings
camille config set cacheToDisk true

# Adjust temperature for more consistent results
camille config set temperature 0.05
```

### Custom Prompts

Camille stores configuration and custom prompts in `~/.camille/`:

```
~/.camille/
├── config.json           # Main configuration
└── prompts/             # Custom prompt templates
    ├── system.txt       # System prompt override
    └── review.txt       # Review prompt override
```

To customize prompts, create files in the prompts directory with your custom content.

## Configuration Options

| Option | Default | Description |
|--------|---------|-------------|
| `openaiApiKey` | - | Your OpenAI API key (required) |
| `models.review` | `gpt-4-turbo-preview` | Model for detailed code review |
| `models.quick` | `gpt-4o-mini` | Model for quick checks |
| `models.embedding` | `text-embedding-3-small` | Model for generating embeddings |
| `temperature` | `0.1` | Low temperature for consistent results |
| `maxTokens` | `4000` | Maximum tokens for responses |
| `cacheToDisk` | `false` | Whether to persist embeddings to disk |
| `ignorePatterns` | `["node_modules/**", "*.log", ...]` | Files to ignore |

## How It Works

### Hook Mode
1. Claude Code triggers the hook before making code changes
2. Camille receives the proposed changes
3. OpenAI reviews the changes for security, compliance, and quality
4. Camille blocks dangerous changes or approves safe ones

### Server Mode
1. Indexes all code files using OpenAI embeddings
2. Watches for file changes and updates the index
3. Provides semantic search through MCP
4. Maintains an in-memory index with optional disk caching

## Security Considerations

- **API Key Security**: Store your OpenAI API key securely using environment variables or the `set-key` command
- **Code Privacy**: All code is sent to OpenAI for analysis. Ensure you have appropriate agreements in place
- **Hook Permissions**: Hooks run with your full user permissions. Camille validates changes but doesn't modify files directly
- **Network Security**: All API calls are made over HTTPS to OpenAI's servers

## Troubleshooting

### "OpenAI API key not configured"
Run `camille set-key YOUR_KEY` or set the `OPENAI_API_KEY` environment variable.

### "Index is still building"
Wait for initial indexing to complete. Check status with `camille server status`.

### Hook not triggering
Ensure the hook configuration is properly added to Claude Code settings and the command path is correct.

### High API costs
- Use `models.quick` for routine checks
- Adjust file ignore patterns to skip unnecessary files
- Enable `cacheToDisk` to avoid re-indexing unchanged files

## Development

### Building from source
```bash
npm install
npm run build
npm test
```

### Running tests
```bash
# Unit tests only
npm test

# Integration tests (requires OpenAI API key)
OPENAI_API_KEY=your_key npm test
```

## Contributing

Contributions are welcome! Please:
1. Fork the repository
2. Create a feature branch
3. Add tests for new functionality
4. Ensure all tests pass
5. Submit a pull request

## License

MIT License - see LICENSE file for details

## Acknowledgments

Built for Claude Code by the community. Special thanks to Anthropic for creating Claude Code and the MCP protocol.