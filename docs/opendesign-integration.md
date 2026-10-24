# OpenDesign Integration for AI Canvas Prototyping

## Overview

Termul now includes OpenDesign MCP server integration, enabling AI agents to build professional website prototypes directly on the Termul canvas.

## How It Works

```
User Prompt (Chat) → AI Agent → OpenDesign MCP → Termul Canvas (Real-time)
```

1. User types a brief in Termul chat (e.g., "create a dark modern landing page")
2. AI agent calls OpenDesign MCP tools to generate prototype
3. Prototype renders in real-time on Termul's built-in canvas editor
4. User can refine via chat, then export to production code

## Installation

OpenDesign CLI (`od`) is automatically installed during Termul setup via `scripts/install-opendesign.sh`.

### Manual Installation (if needed)

```bash
# Via npm (cross-platform)
npx -y od start --mcp

# macOS (Homebrew)
brew install nexu-io/tap/od

# Verify
od --version
```

## Configuration

MCP config uses environment variables for universal compatibility:

```json
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
    }
  }
}
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `OD_PROJECT_ROOT` | Project root for OpenDesign | `${workspaceFolder}` |
| `TERMUL_CANVAS_PORT` | Canvas MCP port | `37291` |
| `TERMUL_PLAN_PORT` | Plan server port | `37291` |
| `TERMUL_PLAN_TOKEN` | Session auth token | Auto-generated |
| `TERMUL_PLAN_SESSION_ID` | Session ID | Auto-generated |
| `TERMUL_PLAN_AGENT_ID` | Agent ID | Auto-generated |

## Usage

### From Chat

Simply type a brief:
```
"Create a dark modern landing page for a SaaS product"
"Design a dashboard with sidebar navigation"
"Prototype a mobile app onboarding flow"
```

### AI Agent Workflow

1. **Canvas Check** - Agent verifies canvas is open
2. **Prototype Generation** - Calls OpenDesign skills/templates
3. **Real-time Render** - Uses `create_node`, `set_properties` on canvas
4. **Refinement Loop** - User feedback → AI updates canvas
5. **Export** - Save as `.pen` file or export to React/Vue/HTML

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  User Chat      │────▶│  AI Agent        │────▶│  OpenDesign MCP │
│  (Termul)       │     │  (Claude/Other)  │     │  (npx od)       │
└─────────────────┘     └──────────────────┘     └────────┬────────┘
                                                          │
                                                          ▼
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Export Code    │◀────│  Refine Loop     │◀────│  Termul Canvas  │
│  (React/Vue/    │     │  (Chat → Canvas) │     │  (FigCraft)     │
│   HTML)         │     │                  │     │                 │
└─────────────────┘     └──────────────────┘     └─────────────────┘
```

## Development

### Running Locally

```bash
# Start Termul with MCP
bun run dev

# In another terminal, start OpenDesign MCP manually
npx od start --mcp

# Open canvas in Termul and start prototyping
```

### Adding New Design Skills

OpenDesign skills live in `.opendesign/skills/`. Add custom skills for your team's design system.

## Troubleshooting

### Canvas Not Opening
- Ensure Termul v0.4.52+ (Canvas Editor experimental)
- Click Canvas button in left rail

### OpenDesign Not Found
```bash
# Re-run install script
./scripts/install-opendesign.sh

# Or manually
npx -y od start --mcp
```

### MCP Connection Failed
- Check `TERMUL_CANVAS_PORT` matches in both configs
- Verify `termul-server` is running with `--internal-mcp-plan-server`

## Related

- [OpenDesign Repository](https://github.com/nexu-io/open-design)
- [Termul Canvas Editor](#1414)
- [MCP Protocol](https://modelcontextprotocol.io/)