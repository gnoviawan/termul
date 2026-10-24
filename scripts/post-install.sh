#!/usr/bin/env bash
# Termul Post-Install Hook
# Runs after Termul installation to set up OpenDesign integration

set -euo pipefail

echo "🔧 Setting up OpenDesign integration..."

# Run OpenDesign install script
if [ -f "./scripts/install-opendesign.sh" ]; then
    chmod +x ./scripts/install-opendesign.sh
    ./scripts/install-opendesign.sh
else
    echo "⚠️  install-opendesign.sh not found, skipping..."
fi

# Create MCP config directory if not exists
mkdir -p .mcp

# Verify MCP config exists
if [ ! -f ".mcp/mcp-config.json" ]; then
    echo "⚠️  MCP config not found, creating default..."
    cat > .mcp/mcp-config.json << 'EOF'
{
  "mcpServers": {
    "open-design": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "od", "start", "--mcp"],
      "env": {
        "OD_PROJECT_ROOT": "${workspaceFolder}",
        "TERMUL_CANVAS_PORT": "${TERMUL_CANVAS_PORT:-37291}"
      }
    },
    "termul": {
      "type": "stdio",
      "command": "termul-server",
      "args": ["--internal-mcp-plan-server"],
      "env": {
        "TERMUL_PLAN_PORT": "${TERMUL_PLAN_PORT:-37291}",
        "TERMUL_PLAN_TOKEN": "${TERMUL_PLAN_TOKEN}",
        "TERMUL_PLAN_SESSION_ID": "${TERMUL_PLAN_SESSION_ID}",
        "TERMUL_PLAN_AGENT_ID": "${TERMUL_PLAN_AGENT_ID}"
      }
    }
  }
}
EOF
fi

echo "✅ OpenDesign integration ready!"
echo ""
echo "🚀 To start prototyping:"
echo "   1. Open Canvas in Termul (left rail button)"
echo "   2. Type a brief in chat: 'Create a dark modern landing page'"
echo "   3. AI will generate prototype on canvas in real-time"