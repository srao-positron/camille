#!/bin/bash

echo "🧪 Testing Git Commit Watcher"
echo "============================="
echo ""

# Create a test git repository
TEST_REPO="/tmp/test-git-repo-$(date +%s)"
echo "📁 Creating test repository: $TEST_REPO"
mkdir -p "$TEST_REPO"
cd "$TEST_REPO"

# Initialize git repo
git init
git config user.email "test@example.com"
git config user.name "Test User"

# Create initial commit
echo "# Test Repository" > README.md
git add README.md
git commit -m "Initial commit: Add README"

echo "✅ Test repository created with initial commit"
echo ""

# Add test repo to Camille config
echo "📝 Adding test repository to Camille config..."
# Add test repo to watchedDirectories (if not already there)
jq --arg repo "$TEST_REPO" '.watchedDirectories += [$repo] | .watchedDirectories |= unique' ~/.camille/config.json > ~/.camille/config.json.tmp && mv ~/.camille/config.json.tmp ~/.camille/config.json

# Start Camille server in the background
echo "🚀 Starting Camille server..."
cd /Users/srao/camille
# Kill any existing Camille server
pkill -f "camille server" 2>/dev/null || true
sleep 1

# Start server
nohup camille server start > /tmp/camille-test.log 2>&1 &
CAMILLE_PID=$!
echo "Camille server started (PID: $CAMILLE_PID)"
sleep 5

# Check that Camille is running
if ! ps -p $CAMILLE_PID > /dev/null; then
    echo "❌ Camille server failed to start"
    cat /tmp/camille-test.log
    exit 1
fi

echo "✅ Camille server is running"
echo ""

# Now make some commits
cd "$TEST_REPO"

echo "📝 Making test commits..."
sleep 2

# Commit 1: Add a new feature
echo "export function authenticate(token: string): boolean {
  return token === 'valid-token';
}" > auth.ts
git add auth.ts
git commit -m "feat: Add authentication function"
echo "  - Created auth.ts with authentication function"
sleep 35  # Wait for git watcher to detect (30s poll interval)

# Commit 2: Fix a bug
echo "export function authenticate(token: string): boolean {
  if (!token) return false;
  return token === 'valid-token';
}" > auth.ts
git add auth.ts
git commit -m "fix: Handle empty token in authentication"
echo "  - Fixed authentication to handle empty tokens"
sleep 35

# Commit 3: Add tests
echo "import { authenticate } from './auth';

test('should authenticate valid token', () => {
  expect(authenticate('valid-token')).toBe(true);
});

test('should reject invalid token', () => {
  expect(authenticate('invalid')).toBe(false);
});" > auth.test.ts
git add auth.test.ts
git commit -m "test: Add authentication tests"
echo "  - Added test file for authentication"
sleep 35

echo ""
echo "✅ Created 3 test commits"
echo ""

# Check logs for git watcher activity
echo "📊 Checking Camille logs for git watcher activity..."
echo "----------------------------------------------------"
grep -i "git\|commit" ~/.camille/logs/camille.log | tail -20

echo ""
echo "📊 Checking for generated design documents..."
echo "----------------------------------------------"
# Check if any design documents were created for these commits
COMMIT_HASHES=$(cd "$TEST_REPO" && git log --oneline -3 | cut -d' ' -f1)
echo "Commit hashes: $COMMIT_HASHES"

# Stop Camille server
echo ""
echo "🛑 Stopping Camille server..."
kill $CAMILLE_PID 2>/dev/null || true
sleep 2

# Clean up
echo "🧹 Cleaning up test repository..."
rm -rf "$TEST_REPO"

echo ""
echo "✅ Test complete!"
echo ""
echo "Check the following for results:"
echo "  1. Camille logs: ~/.camille/logs/camille.log"
echo "  2. Git state: ~/.camille/git-state.json"
echo "  3. Design documents portal: http://localhost:3000/portal/design-documents"