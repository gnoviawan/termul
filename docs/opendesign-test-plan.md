# OpenDesign Canvas Prototyping Test

## Test Plan

### Prerequisites
- Termul v0.4.52+ (Canvas Editor experimental)
- Node.js 18+ installed
- Canvas opened in Termul (left rail button)

### Test Cases

#### 1. Auto-Install OpenDesign
```bash
./scripts/install-opendesign.sh
```
**Expected:** `od` command available, MCP server starts with `npx -y od start --mcp`

#### 2. Post-Install Hook
```bash
./scripts/post-install.sh
```
**Expected:** MCP config created/updated, OpenDesign installed

#### 3. Canvas Prototype Generation
1. Open Termul Canvas
2. In chat: "Create a dark modern landing page for a SaaS product"
3. AI should:
   - Check canvas is open
   - Call OpenDesign MCP
   - Generate Navbar + Hero on canvas
   - Render in real-time

#### 4. Real-time Refinement
1. User: "Add a features section with 3 cards"
2. AI updates canvas with features section
3. User: "Change accent color to blue"
4. AI updates design tokens on canvas

#### 5. Export to Code
1. User: "Export to React with Tailwind"
2. AI generates production-ready components
3. Design tokens preserved

#### 6. Design System Extraction
1. Run design-system-builder agent
2. Extract tokens from canvas
3. Generate design-tokens.json
4. Verify Figma sync capability

### Environment Variables Test
Test with custom values:
```bash
export OD_PROJECT_ROOT="/custom/path"
export TERMUL_CANVAS_PORT="40000"
export TERMUL_PLAN_PORT="40000"
# Restart Termul, verify config uses custom values
```

### CI Verification
- [ ] `bun run ci` passes
- [ ] `bun run typecheck` passes
- [ ] `bun run test` passes
- [ ] `cargo clippy --all-targets -- -D warnings` passes
- [ ] `cargo test` passes

### Manual Verification
- [ ] Canvas opens correctly
- [ ] OpenDesign MCP connects
- [ ] Prototype renders in real-time
- [ ] Refinement loop works
- [ ] Export produces valid code
- [ ] Design tokens extract correctly