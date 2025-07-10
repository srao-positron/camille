/**
 * Prompt templates for OpenAI interactions
 * Emphasizes security review, code quality, and compliance checking
 */

/**
 * System prompt for code review with security emphasis
 */
export const SYSTEM_PROMPT = `You are an expert code reviewer with deep expertise in software security, code quality, and compliance verification. Your primary responsibilities are:

1. **Security Analysis**: Identify potential security vulnerabilities including:
   - Injection attacks (SQL, command, LDAP, etc.)
   - Authentication and authorization flaws
   - Sensitive data exposure
   - Security misconfigurations
   - Cross-site scripting (XSS)
   - Insecure deserialization
   - Using components with known vulnerabilities
   - Insufficient logging and monitoring
   - API security issues
   - Cryptographic failures

2. **Compliance Verification**: Ensure code adheres to:
   - Project-specific rules defined in CLAUDE.md
   - Development guidelines and coding standards
   - Architectural decisions and patterns
   - Team conventions and best practices

3. **Code Quality Assessment**: Review for:
   - Maintainability and readability
   - Performance implications
   - Error handling and edge cases
   - Test coverage considerations
   - Documentation completeness

You have access to a tool that allows you to read any file in the repository. Use this tool proactively to:
- Read CLAUDE.md and development rules
- Examine referenced architecture documents
- Check related code files for context
- Verify consistency across the codebase

Provide actionable, specific feedback. Be thorough but concise. Focus on issues that matter for security, compliance, and code quality.`;

/**
 * User prompt template for code review requests
 */
export const REVIEW_PROMPT_TEMPLATE = `Please review the following code changes for security vulnerabilities, compliance with project rules, and code quality issues.

**Repository Context:**
- Working Directory: {{workingDirectory}}
- Files Changed: {{filesChanged}}

**Code Changes:**
{{codeChanges}}

**Review Instructions:**
1. First, read the CLAUDE.md file and any development rules in the repository
2. If these documents reference other files (like architecture docs), read those too
3. Analyze the code changes for:
   - Security vulnerabilities (prioritize critical and high severity issues)
   - Compliance with documented project rules and standards
   - Code quality and best practices
   - Potential bugs or edge cases

**Expected Output Format:**
Provide your review in the following structure:
- **Security Issues**: List any security vulnerabilities found
- **Compliance Violations**: Note any deviations from project rules
- **Code Quality**: Highlight quality concerns
- **Suggestions**: Provide specific, actionable improvements
- **Approval Status**: APPROVED, NEEDS_CHANGES, or REQUIRES_SECURITY_REVIEW`;

/**
 * Tool description for file reading capability
 */
export const FILE_READER_TOOL = {
  type: 'function' as const,
  function: {
    name: 'read_file',
    description: 'Read the contents of a file in the repository. Use this to read CLAUDE.md, development rules, architecture documents, or any other files needed for context.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The relative path to the file from the repository root'
        }
      },
      required: ['path']
    }
  }
};

/**
 * Prompt for quick compliance checks
 */
export const QUICK_CHECK_PROMPT = `Perform a quick security and compliance check on the following code change. Focus on obvious security issues and clear violations of common best practices. Be concise but thorough.

Code change:
{{codeChange}}

Respond with:
- Any critical security issues
- Obvious compliance violations
- Quick improvement suggestions`;

/**
 * Prompt for generating code embeddings
 */
export const EMBEDDING_PROMPT = `Generate a searchable summary of this code file focusing on:
- Primary functionality and purpose
- Key classes, functions, and methods
- Security-relevant features
- Dependencies and integrations
- Important algorithms or business logic`;

/**
 * Helper function to populate template variables
 */
export function populateTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return variables[key] || match;
  });
}