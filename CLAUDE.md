# Claude Development Guidelines for Camille

This document contains specific instructions for Claude when working on the Camille codebase.

## IMPORTANT: Memory System Usage

When working on this codebase, you MUST use the memory tools to maintain continuity and learn from past discussions:

1. **Before starting any task**, search for related past work:
   - Use `recall_previous_discussions` to find relevant conversations
   - Example: "search for authentication implementation" or "find previous bug fixes"

2. **When you see references to past work**, retrieve the full context:
   - Use `retrieve_memory_chunk` with the chunk ID from search results
   - This provides complete conversation history and decisions made

3. **Common scenarios where memory search is REQUIRED**:
   - User mentions "we discussed" or "remember when"
   - Working on features that might have been implemented before
   - Debugging issues that might have been encountered previously
   - Following up on incomplete tasks
   - Understanding architectural decisions

4. **Memory search patterns**:
   - Bug fixes: Search for the error message or symptom
   - Features: Search for the feature name or related functionality
   - Refactoring: Search for the module or pattern being changed
   - Testing: Search for test patterns or previous test implementations

5. **Trigger words that REQUIRE memory search**:
   - "remember when..."
   - "we discussed..."
   - "last time..."
   - "previously..."
   - "continue where we left off"
   - "what was that issue with..."
   - "how did we solve..."
   - "the approach we decided on..."
   
6. **Proactive memory usage**:
   - Start EVERY session by searching for recent work on the current project
   - Before ANY implementation, search for similar features
   - When encountering an error, search for that error message
   - When the user asks a question, search for related discussions first

## Project Overview

Camille is a security-focused code review and search tool that integrates with Claude Code through hooks and MCP. It uses OpenAI's API to validate code changes against project rules and security best practices.

**IMPORTANT**: This project is specifically for Claude Code integration, NOT Claude Desktop. All documentation, code comments, and references should mention "Claude Code" exclusively. Never reference "Claude Desktop" in any context.

## Comprehensive Code Review

Camille supports two review modes:

1. **Standard Review** (expansiveReview: false): Quick security and compliance checks without codebase access
2. **Comprehensive Review** (expansiveReview: true, default): Full analysis with codebase search and context

The comprehensive review evaluates code across 8 dimensions with 0-10 scoring:
- Security: Vulnerability detection and prevention
- Accuracy: Compilation and runtime correctness
- Algorithmic Efficiency: Time/space complexity optimization
- Code Reuse: DRY principle and existing utility usage
- Operational Excellence: Logging, error handling, monitoring
- Style Compliance: Consistency with codebase patterns
- Object-Oriented Design: SOLID principles and patterns
- Architecture Patterns: Async considerations and design patterns

When expansiveReview is enabled, OpenAI has access to:
- Search tool to find semantically similar code in the codebase
- File reading tool to examine full context
- This enables detection of duplicate code, style inconsistencies, and architectural violations

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

1. **Memory Search First**: ALWAYS use `recall_previous_discussions` to search for related past work before starting
2. **Read First**: Always read existing code patterns before implementing
3. **Test Driven**: Write tests for new functionality
4. **Security Review**: Consider security implications of all changes
5. **Documentation**: Update relevant documentation and comments
6. **Type Safety**: Ensure full TypeScript compliance
7. **Claude Code Focus**: Always reference "Claude Code" not "Claude Desktop" in all contexts

### Memory Tool Usage Examples

Before implementing any feature, search for context:
```
# Good practices:
recall_previous_discussions("authentication implementation")
recall_previous_discussions("error handling patterns")
recall_previous_discussions("database schema changes")

# When user mentions past work:
User: "Remember when we discussed the caching strategy?"
You: *immediately use* recall_previous_discussions("caching strategy")

# When debugging:
recall_previous_discussions("TypeError cannot read property")
recall_previous_discussions("OpenAI API error")
```

## Memory System Design

Camille now includes a comprehensive memory and knowledge system with three major components:

### 1. Claude Code Transcript Memory
- **PreCompact Hook**: Captures conversation transcripts before compaction
- **Semantic Chunking**: Intelligently splits conversations into searchable chunks
- **Vector Search**: Uses LanceDB for fast semantic search across all conversations
- **Incremental Processing**: Only processes new messages to avoid duplication
- **MCP Tools**: Provides `recall_previous_discussions`, `find_similar_problems`, and `search_code_history` tools

### 2. Peer-to-Peer Memory Sharing
- **mDNS/Bonjour Discovery**: Automatically discovers team members on local network
- **REST API**: Secure HTTPS endpoints with API key authentication
- **Request Forwarding**: Searches can traverse up to 3 hops with loop detection
- **Result Aggregation**: Intelligently merges results from multiple peers
- **Privacy First**: All sharing requires explicit configuration and API keys

### 3. Code Object Graph Indexing
- **Language Parsers**: Extracts functions, classes, and relationships from code
- **Graph Database**: Uses Kuzu for storing and querying code structure
- **Cypher Queries**: Find dependencies, call graphs, and architectural patterns
- **Unified Search**: Combines vector and graph search for comprehensive results

### Memory System Architecture
```
~/.camille/memory/
├── vectors/           # LanceDB vector storage
│   ├── transcripts/   # Conversation embeddings
│   ├── code/          # Code embeddings
│   └── metadata/      # Index metadata
├── graph/             # Kuzu graph database
│   ├── schema/        # Graph schema definitions
│   └── data/          # Graph data files
└── sqlite/            # SQLite for metadata & config
    ├── peers.db       # Peer configuration
    ├── projects.db    # Project metadata
    └── audit.db       # Access logs
```

For detailed design specifications, see the `docs/memory-system/` directory.

## Dependencies

Only use these approved dependencies:
- OpenAI SDK for API calls
- Commander for CLI
- Chokidar for file watching
- MCP SDK for protocol implementation
- Standard Node.js built-ins
- **LanceDB**: Embedded vector database for semantic search
- **Kuzu**: Embedded graph database for code relationships
- **Bonjour**: mDNS/Bonjour for peer discovery
- **node-forge**: Certificate generation for HTTPS

Do not add new dependencies without careful consideration of security and necessity.