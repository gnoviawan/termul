# Design System Builder Agent

## Workflow: OpenDesign Canvas → Design System

**MANDATORY:** When extracting or building design systems:

1. **Canvas Source** - Design system originates from OpenDesign canvas prototype
2. **Token Extraction** - Pull variables, styles, components from live canvas
3. **System Generation** - Generate reusable design system package

## Canvas-to-Design-System Flow

```
OpenDesign Prototype → Canvas Inspection → Token Extraction → Design System
```

### Step 1: Prototype as Source
- User creates/opens prototype on Termul canvas via OpenDesign
- AI inspects canvas: `inspect_document`, `get_node`
- All design decisions visible on canvas

### Step 2: Extract Design Tokens
From canvas, extract:
- **Color Variables** - All fills, strokes, opacity
- **Spacing Variables** - Auto-layout gaps, padding
- **Typography Variables** - Font families, sizes, line heights
- **Roundness Variables** - Corner radius values
- **Shadow/Effect Variables** - Drop shadows, blurs

### Step 3: Component Library
Extract components from canvas:
- Identify component instances (`type: "component"`)
- Map variants (size, state, theme)
- Document slots/props
- Generate Code Connect mappings

### Step 4: Generate Output
Produce:
- `design-tokens.json` (Style Dictionary format)
- `components/` (React/Vue/HTML components)
- `figma-design-system/` (Figma library sync)
- `documentation/` (Storybook/Zeroheight)

## OpenDesign MCP Tools for Extraction

```javascript
// Get all design variables from canvas
const variables = await mcp.get_variable_defs({ nodeId: "0:1" });

// Get component metadata
const components = await mcp.list_file_components_for_code_connect({ fileKey });

// Get design context for code generation
const context = await mcp.get_design_context({ nodeId, fileKey });
```

## Design Token Structure (Auto-generated)

```json
{
  "color": {
    "background": { "value": "#0f0f0f", "type": "color" },
    "surface": { "value": "#1a1a1a", "type": "color" },
    "primary": { "value": "#00ff9d", "type": "color" },
    "on-primary": { "value": "#000000", "type": "color" },
    "text-primary": { "value": "#ffffff", "type": "color" },
    "text-secondary": { "value": "#aaaaaa", "type": "color" }
  },
  "spacing": {
    "xs": { "value": "4px", "type": "dimension" },
    "sm": { "value": "8px", "type": "dimension" },
    "md": { "value": "16px", "type": "dimension" },
    "lg": { "value": "24px", "type": "dimension" },
    "xl": { "value": "32px", "type": "dimension" }
  },
  "borderRadius": {
    "none": { "value": "0px", "type": "borderRadius" },
    "sm": { "value": "4px", "type": "borderRadius" },
    "md": { "value": "8px", "type": "borderRadius" },
    "lg": { "value": "16px", "type": "borderRadius" },
    "full": { "value": "9999px", "type": "borderRadius" }
  },
  "typography": {
    "fontFamily": { "value": "Inter", "type": "fontFamily" },
    "fontWeightRegular": { "value": "400", "type": "fontWeight" },
    "fontWeightMedium": { "value": "500", "type": "fontWeight" },
    "fontWeightSemiBold": { "value": "600", "type": "fontWeight" },
    "fontWeightBold": { "value": "700", "type": "fontWeight" }
  }
}
```

## Integration Files
- `.mcp/mcp-config.json` - MCP config for OpenDesign
- `scripts/install-opendesign.sh` - Auto-install
- `docs/opendesign-integration.md` - Full docs

## Testing
- Tokens extract from canvas correctly
- Components map to Code Connect
- Generated system works in target framework
- Figma sync produces identical visuals