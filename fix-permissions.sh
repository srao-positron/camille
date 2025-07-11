#!/bin/bash

# Fix permissions for Camille configuration directory
# This script fixes ownership issues when setup was run with sudo

CAMILLE_DIR="$HOME/.camille"

echo "🔧 Fixing permissions for Camille configuration..."

# Check if the directory exists
if [ ! -d "$CAMILLE_DIR" ]; then
    echo "❌ Camille configuration directory not found at $CAMILLE_DIR"
    exit 1
fi

# Get current user
CURRENT_USER=$(whoami)

# Fix ownership
echo "Changing ownership to $CURRENT_USER..."
sudo chown -R "$CURRENT_USER:staff" "$CAMILLE_DIR"

# Fix permissions
echo "Setting correct permissions..."
chmod 755 "$CAMILLE_DIR"
chmod 644 "$CAMILLE_DIR/config.json" 2>/dev/null || true
chmod 755 "$CAMILLE_DIR/prompts" 2>/dev/null || true
chmod 644 "$CAMILLE_DIR/prompts"/* 2>/dev/null || true

echo "✅ Permissions fixed successfully!"
echo ""
echo "Next steps:"
echo ""
echo "1. Re-run the setup wizard (WITHOUT sudo):"
echo "   camille setup"
echo ""
echo "2. This will:"
echo "   • Update YOUR Claude settings (not root's)"
echo "   • Configure MCP server properly"
echo "   • Set up hooks in the right location"
echo ""
echo "3. Then start the server:"
echo "   camille server start"