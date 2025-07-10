# Claude Development Guidelines for Camille

This document contains specific instructions for Claude when working on the Camille codebase.

## Project Overview

Camille is a security-focused code review and search tool that integrates with Claude Code through hooks and MCP. It uses OpenAI's API to validate code changes against project rules and security best practices.

**IMPORTANT**: This project is specifically for Claude Code integration, NOT Claude Desktop. All documentation, code comments, and references should mention "Claude Code" exclusively. Never reference "Claude Desktop" in any context.

## Core Principles

1. **Security First**: All code changes must prioritize security. Never introduce code that could expose secrets, create vulnerabilities, or bypass security checks.

2. **Fail Fast**: When errors occur, fail immediately with clear error messages rather than attempting recovery that might hide issues.

3. **Type Safety**: Use TypeScript's type system fully. Avoid `any` types except when absolutely necessary.

4. **Comprehensive Documentation**: Every public function, class, and interface must have JSDoc comments explaining purpose, parameters, and return values.

## Architecture

The project is organized into these core modules:

- `config.ts`: Configuration management with home directory storage
- `hook.ts`: Claude Code hook implementation for code review
- `server.ts`: Background server for file watching and indexing
- `mcp-server.ts`: MCP server providing tools to Claude
- `embeddings.ts`: Vector embedding management and search
- `openai-client.ts`: OpenAI API wrapper with tool support
- `prompts.ts`: Prompt templates emphasizing security review

## Code Style Rules

### TypeScript Conventions
```typescript
// Use explicit types for function parameters and returns
function processFile(path: string): Promise<EmbeddedFile>

// Use interfaces for data structures
interface ReviewResult {
  securityIssues: string[];
  // ...
}

// Use const for immutable values
const DEFAULT_TEMPERATURE = 0.1;
```

### Error Handling
```typescript
// Always throw Error objects with descriptive messages
throw new Error(`OpenAI API error: ${error.message}`);

// Fail fast in hooks - return blocking errors
return {
  continue: false,
  decision: 'block',
  reason: `Validation failed: ${error.message}`
};
```

### Async/Await
- Always use async/await instead of callbacks or raw promises
- Handle errors with try/catch blocks
- Ensure all async operations are properly awaited

## Security Requirements

1. **API Key Handling**:
   - Never log or expose API keys
   - Load from environment variables or secure config
   - Mask keys when displaying config (`***` + last 4 chars)

2. **File System Access**:
   - Validate all file paths
   - Use path.join() for cross-platform compatibility
   - Respect ignore patterns from configuration

3. **External API Calls**:
   - Always use HTTPS
   - Set appropriate timeouts
   - Handle rate limits gracefully

4. **Code Review Focus**:
   - Prioritize security vulnerabilities
   - Check for hardcoded secrets
   - Validate input sanitization
   - Flag unsafe operations (eval, exec, etc.)

## Testing Requirements

1. **Test Coverage**: Maintain at least 80% code coverage
2. **Test Types**:
   - Unit tests for all modules
   - Integration tests with real API calls (when API key provided)
   - Mock external dependencies in unit tests

3. **Test Organization**:
   ```typescript
   describe('ModuleName', () => {
     describe('functionName', () => {
       it('should handle normal case', () => {
         // Test implementation
       });
       
       it('should handle error case', () => {
         // Test error handling
       });
     });
   });
   ```

## Performance Considerations

1. **Embedding Index**:
   - Keep in memory for fast searches
   - Optional disk caching for persistence
   - Limit file size for embedding (100KB max)

2. **API Usage**:
   - Use GPT-4o mini for routine checks
   - Reserve GPT-4 Turbo for complex analysis
   - Batch operations when possible

3. **File Watching**:
   - Use chokidar for efficient file system monitoring
   - Debounce rapid changes
   - Queue indexing operations

## MCP Integration Guidelines

When implementing MCP tools:

1. **Comprehensive Documentation**: Each tool must have detailed descriptions explaining what it does, when to use it, and example queries.

2. **Clear Parameter Schemas**: Define all parameters with types and descriptions.

3. **Error Responses**: Return structured error objects rather than throwing.

4. **Status Checks**: Always verify server/index readiness before operations.

## Git Commit Conventions

Follow conventional commits:
- `feat:` New features
- `fix:` Bug fixes
- `docs:` Documentation changes
- `test:` Test additions/changes
- `refactor:` Code refactoring
- `chore:` Build/tooling changes

## When Making Changes

1. **Read First**: Always read existing code patterns before implementing
2. **Test Driven**: Write tests for new functionality
3. **Security Review**: Consider security implications of all changes
4. **Documentation**: Update relevant documentation and comments
5. **Type Safety**: Ensure full TypeScript compliance
6. **Claude Code Focus**: Always reference "Claude Code" not "Claude Desktop" in all contexts

## Dependencies

Only use these approved dependencies:
- OpenAI SDK for API calls
- Commander for CLI
- Chokidar for file watching
- MCP SDK for protocol implementation
- Standard Node.js built-ins

Do not add new dependencies without careful consideration of security and necessity.