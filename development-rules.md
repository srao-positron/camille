# Development Rules for Camille

This document defines the development standards and rules that all code in the Camille project must follow.

## Code Quality Standards

### 1. Type Safety
- **RULE**: No `any` types except when interfacing with external untyped libraries
- **RULE**: All function parameters and return types must be explicitly typed
- **RULE**: Use strict TypeScript configuration (strict: true)

### 2. Error Handling
- **RULE**: Never silently swallow errors
- **RULE**: All async functions must have try/catch blocks
- **RULE**: Error messages must be descriptive and actionable
- **RULE**: In hook mode, errors must fail fast with exit code 2

### 3. Security
- **RULE**: Never log sensitive information (API keys, tokens, passwords)
- **RULE**: All file paths must be validated and sanitized
- **RULE**: External input must be validated before use
- **RULE**: Use parameterized queries/commands, never string concatenation

### 4. Testing
- **RULE**: All new features must have corresponding tests
- **RULE**: Tests must cover both success and failure cases
- **RULE**: Integration tests must mock external APIs to avoid costs
- **RULE**: Maintain minimum 80% code coverage

## Architecture Rules

### 1. Module Boundaries
- **RULE**: Each module must have a single, clear responsibility
- **RULE**: Modules must not have circular dependencies
- **RULE**: Configuration must be centralized in the ConfigManager

### 2. API Design
- **RULE**: All public APIs must have JSDoc documentation
- **RULE**: Functions should do one thing well
- **RULE**: Prefer composition over inheritance
- **RULE**: Return structured data, not raw strings when possible

### 3. Performance
- **RULE**: File operations must be async
- **RULE**: Large files (>100KB) must be truncated before processing
- **RULE**: Embedding operations must be queued to avoid overwhelming the API
- **RULE**: Use streaming for large data sets

## OpenAI Integration Rules

### 1. API Usage
- **RULE**: Always use the lowest-cost model that meets requirements
- **RULE**: Set temperature to 0.1 for consistent results
- **RULE**: Include rate limit handling and retries
- **RULE**: Log API errors with enough context for debugging

### 2. Prompt Engineering
- **RULE**: System prompts must emphasize security first
- **RULE**: Prompts must request structured output formats
- **RULE**: Include examples in prompts for clarity
- **RULE**: Keep prompts focused and concise

### 3. Cost Management
- **RULE**: Use GPT-4o mini for routine operations
- **RULE**: Reserve GPT-4 Turbo for complex security analysis
- **RULE**: Cache embeddings to avoid regeneration
- **RULE**: Implement token counting before API calls

## MCP Server Rules

### 1. Tool Design
- **RULE**: Tools must have descriptive names prefixed with "camille_"
- **RULE**: Tool descriptions must include usage examples
- **RULE**: Parameters must have clear types and descriptions
- **RULE**: Tools must validate inputs before processing

### 2. Communication
- **RULE**: Use named pipes for local IPC
- **RULE**: All responses must be valid JSON
- **RULE**: Include error details in response objects
- **RULE**: Never throw exceptions to the MCP client

## File System Rules

### 1. Path Handling
- **RULE**: Always use path.join() for cross-platform compatibility
- **RULE**: Validate paths are within expected directories
- **RULE**: Check file existence before operations
- **RULE**: Handle file system errors gracefully

### 2. File Watching
- **RULE**: Respect .gitignore patterns by default
- **RULE**: Ignore binary and large files
- **RULE**: Debounce rapid file changes
- **RULE**: Clean up watchers on shutdown

## Configuration Rules

### 1. Storage
- **RULE**: User configuration goes in ~/.camille/
- **RULE**: Sensitive data must not be in config files
- **RULE**: Provide sensible defaults for all options
- **RULE**: Validate configuration on load

### 2. Environment
- **RULE**: Support environment variables for all secrets
- **RULE**: Environment variables override config files
- **RULE**: Document all environment variables
- **RULE**: Never commit .env files

## CLI Rules

### 1. Command Design
- **RULE**: Commands must be intuitive and follow conventions
- **RULE**: Provide helpful error messages with suggestions
- **RULE**: Include --help for all commands
- **RULE**: Use consistent flag names across commands

### 2. Output
- **RULE**: Use colors to improve readability (via chalk)
- **RULE**: Error output goes to stderr
- **RULE**: Success messages should be concise
- **RULE**: Progress indicators for long operations

## Git and Version Control

### 1. Commits
- **RULE**: Follow conventional commit format
- **RULE**: Commits must be atomic and focused
- **RULE**: Include tests with feature commits
- **RULE**: Reference issues in commit messages

### 2. Branches
- **RULE**: Feature branches from main
- **RULE**: Branch names: feature/*, fix/*, docs/*
- **RULE**: Require PR reviews before merge
- **RULE**: Keep main branch deployable

## Documentation Rules

### 1. Code Documentation
- **RULE**: All exports must have JSDoc comments
- **RULE**: Complex algorithms need inline explanations
- **RULE**: Include examples in documentation
- **RULE**: Keep documentation in sync with code

### 2. User Documentation
- **RULE**: README must have clear installation steps
- **RULE**: Include troubleshooting section
- **RULE**: Provide real-world usage examples
- **RULE**: Document all configuration options

## Dependency Management

### 1. Adding Dependencies
- **RULE**: Justify each new dependency
- **RULE**: Check dependency security (no known vulnerabilities)
- **RULE**: Prefer well-maintained packages
- **RULE**: Minimize dependency tree depth

### 2. Updates
- **RULE**: Keep dependencies up to date
- **RULE**: Test thoroughly after updates
- **RULE**: Document breaking changes
- **RULE**: Use exact versions in package.json

## Release Process

### 1. Versioning
- **RULE**: Follow semantic versioning
- **RULE**: Update CHANGELOG.md with each release
- **RULE**: Tag releases in git
- **RULE**: Include migration guides for breaking changes

### 2. Quality Gates
- **RULE**: All tests must pass
- **RULE**: No linting errors
- **RULE**: Code coverage meets minimum
- **RULE**: Security scan passes

## Monitoring and Logging

### 1. Logging
- **RULE**: Log important operations and errors
- **RULE**: Use structured logging where possible
- **RULE**: Include context in error logs
- **RULE**: Never log sensitive data

### 2. Metrics
- **RULE**: Track API usage and costs
- **RULE**: Monitor indexing performance
- **RULE**: Record hook execution times
- **RULE**: Alert on repeated failures