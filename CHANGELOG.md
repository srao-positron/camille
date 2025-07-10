# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2024-01-XX

### Added
- Initial release of Camille
- Claude Code hook integration for automatic code review
- Server mode with file watching and real-time indexing
- MCP server providing code search and validation tools
- Semantic code search using OpenAI embeddings
- Security-focused code review with emphasis on vulnerability detection
- Configuration management with home directory storage
- Support for custom prompts
- Comprehensive test suite
- Full documentation and examples

### Security
- Secure API key storage
- Input validation for all file operations
- Fail-fast approach for security issues

### Performance
- Efficient in-memory embeddings index
- Optional disk caching for persistence
- Smart model selection (GPT-4o mini for routine, GPT-4 Turbo for complex)
- Concurrent file processing with queue management