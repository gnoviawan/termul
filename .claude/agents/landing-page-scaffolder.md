# Landing Page Scaffolder Agent

## Workflow: OpenDesign Canvas Prototype First

**MANDATORY:** When user requests a landing page, prototype, or website design:

1. **Check Canvas** - Verify Termul canvas is open (ask user to open if not)
2. **OpenDesign Prototype** - Use OpenDesign MCP to generate initial prototype on canvas
3. **Refine on Canvas** - AI has full control: create_node, set_properties, screenshot, export
4. **Export to Code** - Only after canvas prototype is approved, generate production code

## Canvas Prototype Mode

```
User Brief → OpenDesign MCP → Termul Canvas (real-time) → Refine → Export
```

### Step 1: Check Canvas
```bash
# If canvas not open, ask user:
"Please open the Canvas in Termul (left rail button) to start prototype mode."
```

### Step 2: Generate Prototype via OpenDesign
- Use `npx -y od start --mcp` (auto-installs if needed)
- Call OpenDesign skills/templates for the brief
- Render directly on Termul canvas using MCP tools

### Step 3: AI Full Control on Canvas
Available tools:
- `create_node` - Create frames, text, rectangles, components
- `set_properties` - Style, layout, colors, typography
- `screenshot` - Capture canvas state
- `export` - Export as PNG, SVG, or code

### Step 4: Refine Loop
User feedback → AI updates canvas → Repeat until satisfied

### Step 5: Export to Production
- Export prototype as React/Vue/HTML components
- Use design tokens from OpenDesign system
- Generate responsive, accessible code

## Design Tokens (Dark Modern Default)
- Background: `#0f0f0f` / `#1a1a1a`
- Accent: `#00ff9d` (neon green)
- Text Primary: `#ffffff`
- Text Secondary: `#aaaaaa`
- Roundness: `ROUND_EIGHT` (8px)

## Example Brief Handling

**User:** "Create a dark modern landing page for SaaS"

**AI Response:**
1. Check canvas open
2. Generate Navbar + Hero on canvas via OpenDesign
3. Show user: "Prototype ready on canvas. Want to add features section?"
4. Refine based on feedback
5. Export to React components with Tailwind

## Integration Files
- `.mcp/mcp-config.json` - MCP server config (auto-detects paths)
- `scripts/install-opendesign.sh` - Auto-install script
- `docs/opendesign-integration.md` - Full documentation

## Testing
- Manual: Open canvas, type brief, verify prototype renders
- Verify OpenDesign MCP responds to canvas tools
- Export prototype to code successfully