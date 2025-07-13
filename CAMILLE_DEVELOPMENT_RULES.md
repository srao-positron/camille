# Camille Development Rules
## Memory-First Development for Claude Code Integration

### 🔴 CRITICAL: These Rules Are Non-Negotiable

These rules MUST be followed in every development session on the Camille codebase. They ensure consistency, prevent duplicate work, and maintain the integrity of Claude's memory system.

---

## Rule 1: Memory Search Before Code

**BEFORE writing any code**, you MUST:

```typescript
// 1. Search for related past work
await recall_previous_discussions("feature name or error message");

// 2. Search existing codebase
await search_code("similar functionality");

// 3. Only then proceed with implementation
```

**Ask yourself:**
- "Has this been discussed before?"
- "Does similar code already exist?"
- "What decisions were made previously?"

---

## Rule 2: TODO-Driven Development

When building any feature, ALWAYS:

```typescript
// Create TODOs immediately
TodoWrite([
  "Search memory for related discussions",
  "Search codebase for similar features",
  "Review existing patterns",
  "Write tests first",
  "Implement feature",
  "Update documentation",
  "Verify with integration tests"
]);
```

---

## Rule 3: Test-First, Always

```typescript
// Write test BEFORE implementation
describe('New Feature', () => {
  it('should work correctly', async () => {
    const result = await newFeature(input);
    expect(result.success).toBe(true);
  });
});

// Only AFTER test is written, implement feature
```

**Current failing tests MUST be fixed before adding new features.**

---

## Rule 4: Consistent MCP Tool Responses

**EVERY MCP tool must return:**

```typescript
// Success case
{
  content: [{
    type: 'text',
    text: 'Human-readable output'
  }],
  success: true,
  data: { /* structured data */ }
}

// Error case
{
  content: [{
    type: 'text',
    text: 'Error: Description of what went wrong'
  }],
  success: false,
  error: {
    code: 'ERROR_CODE',
    message: 'Detailed error message'
  }
}
```

---

## Rule 5: Memory Integration Points

**These scenarios REQUIRE memory usage:**

### Trigger Words:
- "remember when..."
- "we discussed..."
- "last time..."
- "previously..."
- "continue where we left off"
- "what was that issue with..."
- "how did we solve..."

### Required Searches:
1. **Before ANY task** - Search for related work
2. **Error debugging** - Search for the error message
3. **Feature implementation** - Search for similar features
4. **Architecture decisions** - Search for past discussions

---

## Rule 6: Helper Scripts Required

For every major feature, create helpers in `utils/`:

```typescript
// utils/test-memory-recall.ts - Test memory search
// utils/seed-conversations.ts - Create test data
// utils/cleanup-vector-db.ts - Database maintenance
// utils/validate-embeddings.ts - Verify embedding quality
```

---

## Rule 7: Security and API Keys

```typescript
// ✅ CORRECT - Masked in logs
logger.info('Using API key', { key: maskApiKey(apiKey) });

// ❌ WRONG - Never log full keys
logger.info('API key:', apiKey);

// API key validation
if (!apiKey || !apiKey.startsWith('sk-')) {
  throw new Error('Invalid OpenAI API key format');
}
```

---

## Rule 8: Vector Database Best Practices

```typescript
// Always close connections
const vectorDB = new LanceVectorDB();
try {
  await vectorDB.connect();
  // ... operations
} finally {
  await vectorDB.close();
}

// Chunk IDs must be deterministic
const chunkId = `${sessionId}-chunk-${index}`;

// Include navigation metadata
metadata: {
  chunkId,
  chunkIndex,
  sessionId,
  projectPath,
  previousChunkId,
  nextChunkId
}
```

---

## Rule 9: Delete Dead Code

**When replacing features:**
1. Build the new implementation
2. Verify it works with tests
3. DELETE all old code immediately
4. No commented-out code
5. No "just in case" code

**Current cleanup needed:**
- Remove duplicate tool registration in server.ts
- Clean up old MCP implementation patterns

---

## Rule 10: Documentation Requirements

**Every public function needs:**

```typescript
/**
 * Searches conversation history using semantic similarity
 * 
 * @param query - Natural language search query
 * @param options - Search options including filters
 * @returns Array of relevant conversation chunks with metadata
 * 
 * @example
 * const results = await recall_previous_discussions("authentication error");
 */
```

---

## Rule 11: Error Handling Patterns

```typescript
// ✅ CORRECT - Descriptive errors with context
throw new Error(`Failed to generate embedding: ${error.message}`);

// ✅ CORRECT - Fail fast in hooks
return {
  continue: false,
  decision: 'block',
  reason: `Security violation: ${details}`
};

// ❌ WRONG - Silent failures
try {
  // risky operation
} catch (error) {
  // Don't silently ignore!
}
```

---

## Rule 12: Build and CI Requirements

**Before EVERY commit:**

```bash
npm run build      # Must pass
npm run test       # Must pass (fix failing tests!)
npm run lint       # Must pass
npm run typecheck  # Must pass
```

**A feature is NOT complete until:**
- All tests pass
- Build succeeds
- Types are correct
- Memory integration works

---

## Workflow Checklist

### When You Receive: "Build feature X"

- [ ] 1. **Search memory** (`recall_previous_discussions`)
- [ ] 2. **Search codebase** (`search_code`, `grep`)
- [ ] 3. **Create TODOs** (`TodoWrite`)
- [ ] 4. **Write test first**
- [ ] 5. **Implement feature**
- [ ] 6. **Update CLAUDE.md if needed**
- [ ] 7. **Create helper scripts**
- [ ] 8. **Run all tests**
- [ ] 9. **Clean up old code**
- [ ] 10. **Verify memory integration**

---

## Red Flags That Require Discussion

**STOP and discuss if you're about to:**
- Skip memory search before implementing
- Add a tool without proper response format
- Create duplicate functionality
- Push with failing tests
- Log sensitive information
- Implement without writing tests first

---

## Quick Reference Card

```
Before coding:
1. Search memory ✓
2. Search codebase ✓
3. Create TODOs ✓
4. Write test ✓

While coding:
- Consistent responses ✓
- Proper error handling ✓
- Security first ✓
- Close connections ✓

After coding:
- Run tests ✓
- Update docs ✓
- Delete old code ✓
- Verify integration ✓
```

---

## Memory System Specific Rules

### Chunk Processing
- Max chunk size: 4000 characters
- Overlap: 200 characters minimum
- Always include metadata for navigation

### Embedding Generation
- Model: text-embedding-3-large
- Batch size: 20 chunks maximum
- Always handle rate limits gracefully

### Search Optimization
- Default limit: 10 results
- Score threshold: 0.5 minimum
- Always include chunk IDs in results

---

## Current Priority Fixes

1. **Fix failing tests** in hook.test.ts
2. **Remove duplicate** tool registration in server.ts
3. **Standardize** all MCP tool responses
4. **Add helper scripts** for memory testing
5. **Update tests** for new memory features

**Remember: Memory-first development prevents duplicate work and maintains continuity.**