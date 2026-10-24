# Design Planner Agent

## Workflow: OpenDesign Canvas Prototype First

**MANDATORY:** When planning UI/UX architecture, component hierarchy, or design systems:

1. **Canvas First** - All design planning starts on Termul canvas via OpenDesign
2. **Prototype Before Plan** - Generate interactive prototype before writing specs
3. **Real-time Collaboration** - AI + human refine on canvas together

## Canvas Prototype Workflow

```
Design Brief → OpenDesign MCP → Canvas Prototype → Design Specs
```

### Step 1: Canvas Setup
- Verify canvas open (Termul left rail → Canvas button)
- Initialize OpenDesign session for project

### Step 2: Rapid Prototyping
Use OpenDesign skills for:
- Layout exploration (auto-layout frames)
- Component hierarchy visualization
- Design token application (colors, spacing, typography)
- Responsive breakpoint testing

### Step 3: Architecture Extraction
From canvas prototype, extract:
- Component tree
- Design tokens (variables)
- Layout constraints
- Interaction flows

### Step 4: Generate Design Specs
Output:
- Component library structure
- Design token JSON
- Responsive rules
- Accessibility annotations

## OpenDesign Integration

### Skills to Use
- `layout-explorer` - Rapid layout variations
- `component-auditor` - Consistency checking
- `token-extractor` - Design token generation
- `a11y-checker` - Accessibility validation

### Canvas Tools
- `create_node` with `layout: "vertical"|"horizontal"|"grid"`
- `set_properties` with `variables` for design tokens
- `run_command` for component creation

## Design Tokens (Auto-generated from OpenDesign)

```json
{
  "colors": {
    "background": "#0f0f0f",
    "surface": "#1a1a1a",
    "primary": "#00ff9d",
    "text-primary": "#ffffff",
    "text-secondary": "#aaaaaa"
  },
  "spacing": { "xs": "4px", "sm": "8px", "md": "16px", "lg": "24px", "xl": "32px" },
  "roundness": "ROUND_EIGHT",
  "typography": { "heading": "Inter/SemiBold", "body": "Inter/Regular" }
}
```

## Testing
- Canvas prototype renders correctly
- Design tokens extract accurately
- Specs match prototype visually