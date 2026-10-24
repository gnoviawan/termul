#!/usr/bin/env bash
# Install OpenDesign CLI (od) for AI-powered canvas prototyping
# This script runs automatically during Termul setup

set -euo pipefail

echo "🎨 Installing OpenDesign CLI..."

# Check if od is already installed
if command -v od &> /dev/null; then
    echo "✅ OpenDesign CLI already installed: $(od --version)"
    exit 0
fi

# Detect OS
OS="$(uname -s)"
case "$OS" in
    Linux*)
        # Try to install via npm (requires Node.js)
        if command -v npx &> /dev/null; then
            echo "📦 Installing OpenDesign via npx..."
            npx -y od start --mcp &
            # Give it a moment to install
            sleep 3
            if command -v od &> /dev/null; then
                echo "✅ OpenDesign installed successfully"
            else
                echo "⚠️  OpenDesign binary not in PATH. You may need to add npm global bin to PATH."
                echo "   Try: export PATH=\"\$(npm bin -g):\$PATH\""
            fi
        else
            echo "❌ Node.js/npm not found. Please install Node.js first."
            echo "   Visit: https://nodejs.org/"
            exit 1
        fi
        ;;
    Darwin*)
        # macOS - try Homebrew first
        if command -v brew &> /dev/null; then
            echo "🍺 Installing OpenDesign via Homebrew..."
            brew install nexu-io/tap/od || {
                echo "⚠️  Homebrew install failed, falling back to npx..."
                npx -y od start --mcp &
                sleep 3
            }
        else
            echo "📦 Installing OpenDesign via npx..."
            npx -y od start --mcp &
            sleep 3
        fi
        ;;
    CYGWIN*|MINGW*|MSYS*)
        # Windows
        echo "📦 Installing OpenDesign via npx..."
        npx -y od start --mcp &
        sleep 3
        ;;
    *)
        echo "❓ Unknown OS: $OS. Trying npx..."
        npx -y od start --mcp &
        sleep 3
        ;;
esac

# Verify installation
if command -v od &> /dev/null; then
    echo "✅ OpenDesign CLI ready: $(od --version)"
    echo ""
    echo "🚀 OpenDesign MCP server will auto-start when you use AI canvas prototyping in Termul."
    echo "   Brief → AI designs on canvas → Real-time preview"
else
    echo "⚠️  OpenDesign may need manual setup. Run: npx od start --mcp"
fi