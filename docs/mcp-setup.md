# MCP (Model Context Protocol) Setup Guide for Claude Code

This guide provides detailed instructions for setting up Camille as an MCP server in Claude Code.

## What is MCP?

MCP (Model Context Protocol) is a protocol that allows Claude Code to interact with external tools and services. When Camille runs as an MCP server, it provides Claude with direct access to:

- **Semantic code search** across your entire codebase
- **Code validation** for security and compliance
- **Real-time index status** monitoring

## Installation Requirements

Before setting up MCP:

1. Install Camille globally:
   ```bash
   npm install -g camille
   ```

2. Configure your OpenAI API key:
   ```bash
   camille config set
   ```

3. Ensure Claude Code is installed and up to date

## Quick Setup

The easiest way to add Camille to Claude Code is using the setup wizard:

```bash
camille setup
```

The wizard will:
1. Configure your OpenAI API key
2. Set up directories to watch
3. Add Camille to Claude Code using the `claude mcp add` command
4. Start the Camille server automatically

## Manual Setup

### Option 1: Using the CLI (Recommended)

Add Camille to Claude Code using the command line:

```bash
# Add at user level (available in all projects)
claude mcp add --scope user camille -- camille server start --mcp

# Add at project level (shared with team via .mcp.json)
claude mcp add --scope project camille -- camille server start --mcp

# Add locally for specific project only
cd /path/to/project
claude mcp add --scope local camille -- camille server start --mcp
```

### Option 2: Using init-mcp Command

Use the built-in command to add Camille to Claude Code:

```bash
# Add to current directory (local scope)
camille init-mcp

# Add to specific directory
camille init-mcp ~/my-project

# Add at user or project level
camille init-mcp --scope user
camille init-mcp --scope project
```

### Option 3: Manual Configuration

If you prefer manual configuration, Claude Code discovers MCP servers from `.mcp.json` files:

```json
{
  "mcpServers": {
    "camille": {
      "command": "camille",
      "args": ["server", "start", "--mcp"],
      "env": {
        "OPENAI_API_KEY": "${OPENAI_API_KEY}"
      }
    }
  }
}
```

## How It Works

When Claude Code starts Camille:

1. **Spawns Process**: Claude Code runs `camille server start --mcp`
2. **Stdio Communication**: Communication happens via standard input/output
3. **Background Indexing**: The server indexes your codebase in the background
4. **Real-time Search**: Claude can search and validate code immediately

## Configuration Scopes

### User Scope
- Configuration stored in Claude Code user settings
- Available across all your projects
- Not shared with team members
- Use: `claude mcp add --scope user`

### Project Scope
- Configuration stored in `.mcp.json` in project root
- Shared with all team members via version control
- Anyone opening the project gets the MCP server
- Use: `claude mcp add --scope project`

### Local Scope
- Configuration stored in Claude Code workspace settings
- Only available in the specific project for you
- Not shared with others
- Use: `claude mcp add --scope local` (default)

## Using Camille Tools in Claude Code

Once configured, you can use natural language to invoke Camille's capabilities:

### Code Search Examples
- "Search for authentication code in the project"
- "Find files related to database connections"
- "Show me where user input is processed"
- "Find similar code to this function"

### Code Validation Examples
- "Validate this code change for security issues"
- "Check if this implementation follows our coding standards"
- "Review this code for compliance with CLAUDE.md"

### Status Checks
- "Is the Camille index ready?"
- "How many files are indexed?"
- "Check Camille server status"

## Available MCP Tools

### camille_search_code
Searches for code using semantic similarity.

**Parameters:**
- `query` (required): Natural language description of what you're looking for
- `limit` (optional): Maximum number of results (default: 10)

**Example:** "Find authentication and user login code"

### camille_validate_changes
Validates proposed code changes against security rules and best practices.

**Parameters:**
- `filePath` (required): Path to the file being changed
- `changes` (required): The code changes or new content
- `changeType` (required): Type of change - "edit", "create", or "delete"

**Example:** "Validate these changes for security issues"

### camille_status
Gets the current status of the Camille server.

**Returns:**
- Server running status
- Index readiness
- Number of indexed files
- Queue size

## Verifying the Setup

1. Check if Camille is listed in Claude Code:
   ```bash
   claude mcp list
   ```

2. In Claude Code, verify Camille is connected by asking:
   - "What MCP tools are available?"
   - "Check Camille server status"

3. Claude should respond with information about the available Camille tools.

## Managing MCP Servers

### List all MCP servers
```bash
claude mcp list
```

### Get details about Camille
```bash
claude mcp get camille
```

### Remove Camille
```bash
claude mcp remove camille
```

## Troubleshooting

### Camille doesn't appear in Claude Code

1. **Verify installation** - Run `which camille` to ensure it's installed
2. **Check Claude Code CLI** - Run `claude --version` to ensure it's installed
3. **List MCP servers** - Run `claude mcp list` to see if Camille is registered
4. **Check configuration** - Run `camille config show` to verify API key

### "Server not running" errors

1. **Start manually** - Try running `camille server start` in a separate terminal
2. **Check API key** - Ensure your OpenAI API key is configured: `camille config show`
3. **Check logs** - Look for errors in the console output

### Index not building

1. **Check ignore patterns** - Run `camille config show` to see ignored files
2. **Verify directory contents** - Ensure directories contain supported file types
3. **Monitor server output** - Look for indexing progress messages
4. **Check file size limits** - Very large files may be skipped

## Advanced Configuration

### Environment Variables

You can pass environment variables to the MCP server:

```bash
claude mcp add -e OPENAI_API_KEY=sk-... camille -- camille server start --mcp
```

### Custom Arguments

Add custom arguments to the server command:

```bash
# Start with specific directories
claude mcp add camille -- camille server start --mcp -d /path/to/project

# Start in quiet mode
claude mcp add camille -- camille server start --mcp --quiet
```

## Security Considerations

1. **API Key Storage**: Your OpenAI API key is stored securely in `~/.camille/config.json`
2. **Directory Access**: Only grant Camille access to directories you want indexed
3. **Process Isolation**: Each MCP server runs as a separate process
4. **Code Privacy**: Remember that code is sent to OpenAI for embedding generation

## Performance Tips

1. **File Size Limits**: Configure `maxFileSize` and `maxIndexFileSize` in your config
2. **Ignore Patterns**: Add large generated files to ignore patterns
3. **Directory Selection**: Only watch directories that need indexing

## Getting Help

- Run `camille --help` for command options
- Run `claude mcp --help` for MCP management options
- Visit the [GitHub repository](https://github.com/srao-positron/camille) for issues
- Check your configuration with `camille config show`