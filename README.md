# Camille

An intelligent code compliance checker and embedding search tool for Claude Code that uses OpenAI to validate code changes against project rules, security best practices, and architectural decisions.

## Features

- **🔒 Security-First Code Review**: Automatically reviews code changes for security vulnerabilities including injection attacks, XSS, authentication flaws, and more
- **📋 Compliance Checking**: Validates code against your project's CLAUDE.md and development rules
- **🔍 Semantic Code Search**: Uses OpenAI embeddings to search your codebase with natural language queries
- **🪝 Claude Code Hook Integration**: Seamlessly integrates with Claude Code to review changes before they're applied
- **🤖 MCP Server**: Provides tools to Claude for searching code and validating changes
- **📁 Smart File Watching**: Automatically indexes new and changed files in real-time
- **⚡ Performance Optimized**: Uses GPT-4.1-mini for routine checks and GPT-4.1 for complex analysis

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

### 1. Run the setup wizard (recommended)
```bash
camille setup
```

This interactive wizard will help you:
- Configure your OpenAI API key
- Select directories to monitor
- Set up Claude Code hooks
- Configure MCP integration
- Enable auto-start service

### Or configure manually:

#### Set your OpenAI API key
```bash
camille set-key YOUR_OPENAI_API_KEY
```

### 2. Configure Claude Code hooks
Add this to your Claude Code settings at `~/.claude/settings.json`:
```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|MultiEdit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "camille hook"
          }
        ]
      }
    ]
  }
}
```

### 3. Add as MCP Server in Claude Code (for search functionality)

Add Camille to Claude Code using the CLI:

```bash
# Add at user level (available in all projects)
claude mcp add --scope user camille -- camille server start --mcp

# Add at project level (shared with team)
claude mcp add --scope project camille -- camille server start --mcp

# Add locally for current project only
claude mcp add camille -- camille server start --mcp
```

Or use the built-in helper command:
```bash
camille init-mcp
```

The MCP server will start automatically when Claude Code needs it.

### 4. Start the server manually (alternative to MCP)
If you prefer to run the server standalone:
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

# Start server with specific directories (supports multiple)
camille server start -d /path/to/project1 /path/to/project2

# Add directories to running server
camille server add-directory /path/to/another/project

# Remove directories from watching
camille server remove-directory /path/to/project

# Check server status (shows all watched directories)
camille server status

# Stop server
camille server stop
```

#### Multi-Directory Support

Camille can watch multiple directories simultaneously:

```bash
# Start with multiple directories
camille server start -d ~/projects/frontend ~/projects/backend ~/projects/shared

# Add more directories while running
camille server add-directory ~/projects/new-service

# Remove a directory
camille server remove-directory ~/projects/old-service
```

Each directory is indexed separately, and searches will include results from all watched directories.

### MCP (Model Context Protocol) Integration

Camille integrates with Claude Code as an MCP server, providing powerful code search and validation tools directly to Claude. This allows Claude to search your codebase semantically and validate changes before applying them.

#### Architecture

Camille uses a centralized service architecture with named pipes:

1. **Central Service**: The main Camille server (`camille server start`) runs as a single instance that:
   - Indexes all configured directories
   - Maintains embeddings in memory with optional disk caching
   - Listens on a named pipe (`/tmp/camille-mcp.sock` on Unix, `\\.\pipe\camille-mcp` on Windows)

2. **MCP Proxy**: When Claude Code needs to communicate with Camille, it spawns a lightweight Python proxy (`mcp-pipe-proxy.py`) that:
   - Receives MCP requests from Claude Code via stdio
   - Forwards them to the central service via named pipe
   - Returns responses back to Claude Code

This architecture ensures:
- Only one indexing service runs regardless of how many Claude Code sessions are active
- All sessions share the same pre-built index for instant searches
- No duplicate indexing or resource waste
- Fast response times since the index is already in memory

#### Named Pipe Protocol

The named pipe uses a simple line-based JSON protocol:

```python
# Send request
{"jsonrpc": "2.0", "method": "tools/call", "params": {...}, "id": 1}

# Receive response  
{"jsonrpc": "2.0", "result": {...}, "id": 1}
```

You can create custom MCP proxies by connecting to the named pipe. See `mcp-pipe-proxy.py` for a reference implementation.

#### Setting up MCP for Claude Code

The setup wizard configures MCP automatically, but you can also set it up manually:

```bash
# Add at user level (available in all projects)
claude mcp add --scope user camille -- python3 /path/to/mcp-pipe-proxy.py

# Add at project level (shared with team)
claude mcp add --scope project camille -- python3 /path/to/mcp-pipe-proxy.py

# Add locally for current project only
claude mcp add camille -- python3 /path/to/mcp-pipe-proxy.py
```

The MCP proxy will connect to your running Camille server automatically.

#### Available MCP Tools

When configured as an MCP server, Claude gains access to these tools:

##### `camille_search_code`
Search for code using natural language queries. This tool uses semantic embeddings to find relevant code even if it doesn't contain exact keyword matches.

**Example queries:**
- "authentication and user login"
- "database connection handling"
- "error logging implementation"
- "functions that process user input"
- "API endpoints for user management"

**Returns:** List of matching files with similarity scores, summaries, and code previews.

##### `camille_validate_changes`
Validate code changes before applying them. This performs the same security and compliance checks as the hook mode.

**Checks for:**
- Security vulnerabilities (injection, XSS, authentication flaws)
- Compliance with CLAUDE.md and project rules
- Code quality and best practices
- Architecture consistency

**Returns:** Approval status with detailed feedback on any issues found.

##### `camille_status`
Check if the Camille server is running and the index is ready.

**Returns:** Server status including:
- Running state
- Index readiness
- Number of indexed files
- Active operations

#### Using MCP Tools in Claude

Once configured, you can ask Claude to:
- "Search for files related to user authentication"
- "Find where database connections are handled"
- "Check if this code change is secure"
- "Validate this implementation against our coding standards"

Claude will automatically use the appropriate Camille tools to help answer your questions.

### Configuration

Re-run the setup wizard anytime:
```bash
camille setup
```

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