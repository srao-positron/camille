#!/bin/bash

echo "🧪 Testing Design Document Generation via PreCompact Hook"
echo "========================================================="
echo ""

# Create a test transcript with some meaningful content
TRANSCRIPT_FILE="/tmp/test-transcript-$(date +%s).jsonl"
SESSION_ID="test-session-$(uuidgen)"

echo "📝 Creating test transcript..."
cat > "$TRANSCRIPT_FILE" << 'EOF'
{"type":"human","timestamp":"2025-08-17T20:00:00Z","content":"Let's implement a new authentication system using JWT tokens"}
{"type":"assistant","timestamp":"2025-08-17T20:00:30Z","content":"I'll help you implement a JWT authentication system. Let me start by creating the necessary files and structure."}
{"type":"human","timestamp":"2025-08-17T20:01:00Z","content":"Make sure to include refresh token support and proper error handling"}
{"type":"assistant","timestamp":"2025-08-17T20:01:30Z","content":"Absolutely! I'll implement a complete JWT authentication system with both access and refresh tokens, along with comprehensive error handling. Let me create the authentication service first."}
{"type":"human","timestamp":"2025-08-17T20:05:00Z","content":"Can we also add rate limiting to prevent brute force attacks?"}
{"type":"assistant","timestamp":"2025-08-17T20:05:30Z","content":"Great security consideration! I'll add rate limiting middleware to protect the authentication endpoints from brute force attacks. Let me implement that now."}
EOF

echo "✅ Transcript created: $TRANSCRIPT_FILE"
echo ""

# Create the PreCompact hook input
HOOK_INPUT=$(cat <<EOF
{
  "session_id": "$SESSION_ID",
  "transcript_path": "$TRANSCRIPT_FILE",
  "hook_event_name": "PreCompact",
  "trigger": "manual",
  "compaction_reason": "manual",
  "project_path": "$(pwd)"
}
EOF
)

echo "🔄 Triggering PreCompact hook..."
echo "$HOOK_INPUT" | node /Users/srao/camille/dist/cli.js memory-hook

echo ""
echo "✅ Hook completed!"
echo ""
echo "📊 Check the Supastate portal for the new design document:"
echo "   https://www.supastate.ai/portal/design-documents"
echo ""
echo "🔍 Session ID: $SESSION_ID"

# Clean up
rm -f "$TRANSCRIPT_FILE"