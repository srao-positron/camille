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
   camille set-key YOUR_OPENAI_API_KEY
   ```

3. Ensure Claude Code is installed and up to date

## How It Works

Camille uses a centralized architecture:

1. **One Central Server**: A single Camille server runs as a system service
2. **Named Pipe Communication**: Projects connect via a named pipe, not spawning new servers
3. **Shared Resources**: All projects share the same indexed codebase and server resources
4. **Efficient Operation**: No duplicate indexing or multiple server instances

## Configuration

### Step 1: Start the Central Camille Server

First, ensure the central Camille server is running with MCP support:

```bash
camille server start --mcp
```

This starts:
- The main indexing and search server
- The MCP named pipe server at `/tmp/camille-mcp.sock` (or `\\.\pipe\camille-mcp` on Windows)

### Step 2: Create .mcp.json in Your Project

Create a `.mcp.json` file in your project root directory:

```json
{
  "mcpServers": {
    "camille": {
      "transport": "pipe",
      "pipeName": "/tmp/camille-mcp.sock"
    }
  }
}
```

On Windows, use:
```json
{
  "mcpServers": {
    "camille": {
      "transport": "pipe",
      "pipeName": "\\\\.\\pipe\\camille-mcp"
    }
  }
}
```

### Step 3: Quick Setup Alternative

Use the built-in command to create the .mcp.json file:

```bash
# In your project directory
camille init-mcp

# Or specify a directory
camille init-mcp ~/my-project
```

### Step 4: Open Project in Claude Code

When you open the project in Claude Code, it will connect to the central Camille service via the named pipe.

## Verifying the Setup

1. In Claude Code, you can verify Camille is connected by asking:
   - "What MCP tools are available?"
   - "Check Camille server status"

2. Claude should respond with information about the available Camille tools.

3. Check the Camille logs at `/tmp/camille.log` for any issues.

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

## Project vs User Scope

By default, `.mcp.json` files are project-scoped and can be committed to version control to share with your team. If you need user-specific configuration, you can add `"scope": "user"` to the configuration.

## Troubleshooting

### Camille doesn't appear in Claude Code

1. **Check .mcp.json syntax** - Ensure valid JSON
2. **Verify Camille is installed globally** - Run `which camille`
3. **Check API key configuration** - Run `camille config show`
4. **Look for error messages** in `/tmp/camille.log`

### "Server not running" errors

1. **Manual test** - Try running `camille server start --mcp` manually
2. **Check API key** - Ensure your OpenAI API key is configured: `camille config show`
3. **Verify directory permissions** - Camille needs read access to watched directories

### Index not building

1. **Check ignore patterns** - Run `camille config show` to see ignored files
2. **Verify directory contents** - Ensure directories contain supported file types
3. **Monitor logs** - Check `/tmp/camille.log` for indexing errors
4. **Check file size limits** - Very large files may be skipped

## Advanced Configuration

### Quiet Mode for Background Operation

If running as a service or in the background, use quiet mode:

```json
{
  "mcpServers": {
    "camille": {
      "command": "camille",
      "args": ["server", "start", "--mcp", "--quiet"]
    }
  }
}
```

### Custom Configuration Directory

You can specify a custom config directory:

```json
{
  "mcpServers": {
    "camille": {
      "command": "camille",
      "args": ["server", "start", "--mcp"],
      "env": {
        "CAMILLE_CONFIG_DIR": "/custom/config/path"
      }
    }
  }
}
```

## Security Considerations

1. **API Key Storage**: Your OpenAI API key is stored securely in `~/.camille/config.json`
2. **Directory Access**: Only grant Camille access to directories you want indexed
3. **Network Security**: MCP communication happens over local named pipes, not network sockets
4. **Code Privacy**: Remember that code is sent to OpenAI for embedding generation

## Performance Tips

1. **File Size Limits**: Configure `maxFileSize` and `maxIndexFileSize` in your config
2. **Ignore Patterns**: Add large generated files to ignore patterns
3. **Multiple Directories**: Each directory is indexed independently for better performance

## Getting Help

- Check logs at `/tmp/camille.log`
- Run `camille --help` for command options
- Visit the [GitHub repository](https://github.com/srao-positron/camille) for issues
- Run `camille config show` to see current configuration