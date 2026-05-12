with open('src/renderer/components/ProjectSidebar.tsx','r',encoding='utf-8') as f:
    content = f.read()

# 1. Import availableColors
content = content.replace(
    'import { getColorClasses } from "@/lib/colors";',
    'import { getColorClasses, availableColors } from "@/lib/colors";'
)
print('Step 1: Import')

# 2. Add settingsColor state - after settingsShell state line
old_state = 'const [settingsShell, setSettingsShell] = useState("");'
new_state = 'const [settingsShell, setSettingsShell] = useState("");\nconst [settingsColor, setSettingsColor] = useState<ProjectColor>("blue");'
content = content.replace(old_state, new_state, 1)
print('Step 2: State added')

# 3. Update useEffect to set settingsColor
# Find block:
# if (project) {
#   setSettingsName(project.name);
#   setSettingsPath(project.path || "");
#   setSettingsShell(project.defaultShell || "");
# }
# Replace with setSettingsColor added
old_effect = '''if (project) {
\t\t\t\tsetSettingsName(project.name);
\t\t\t\tsetSettingsPath(project.path || "");
\t\t\t\tsetSettingsShell(project.defaultShell || "");
\t\t\t}'''
new_effect = '''if (project) {
\t\t\t\tsetSettingsName(project.name);
\t\t\t\tsetSettingsPath(project.path || "");
\t\t\t\tsetSettingsShell(project.defaultShell || "");
\t\t\t\tsetSettingsColor(project.color || "blue");
\t\t\t}'''
content = content.replace(old_effect, new_effect)
print('Step 3: Effect updated')

# 4. Add color field after path field closing div and before Shell Field comment
# Markers:
#   We'll search for: `{/* Shell Field */}` and insert before it.
#   Ensure that we insert after the closing div that ends the Path Field.
#   But easier: insert right before `{/* Shell Field */}`.
marker = '/* Shell Field */'
pos = content.find(marker)
if pos != -1:
    # Insert block before this comment, ensuring preceding newline
    # The path field outer div's closing `</div>` and a blank line are before this comment.
    # We'll insert after any preceding `</div>` and newline, but before comment.
    # We'll insert the whole block.
    color_block = (
        '{/* Color Picker */}\n'
        '<div className="space-y-2 mt-4">\n'
        '\t<label className="block text-xs font-medium text-muted-foreground mb-1">Color</label>\n'
        '\t<div className="flex gap-2">\n'
        '\t\t{availableColors.map((color) => {\n'
        '\t\t\tconst colors = getColorClasses(color)\n'
        '\t\t\treturn (\n'
        '\t\t\t\t<button\n'
        '\t\t\t\t\tkey={color}\n'
        '\t\t\t\t\ttype="button"\n'
        '\t\t\t\t\tonClick={() => setSettingsColor(color)}\n'
        '\t\t\t\t\tclassName={cn(\n'
        '\t\t\t\t\t\t"w-6 h-6 rounded-full transition-all",\n'
        '\t\t\t\t\t\tcolors.bg,\n'
        '\t\t\t\t\t\tsettingsColor === color\n'
        '\t\t\t\t\t\t\t? "ring-2 ring-offset-2 ring-offset-card ring-current"\n'
        '\t\t\t\t\t\t\t: "hover:opacity-80",\n'
        '\t\t\t\t\t)}\n'
        '\t\t\t\t/>\n'
        '\t\t\t)}\n'
        '\t\t</div>\n'
        '</div>\n\n'
    )
    # But the marker line we should match exactly, and we need to ensure proper indent.
    # The comment `/* Shell Field */` appears within JSX at a specific indentation level: likely `\t\t\t\t\t\t{/* Shell Field */}`.
    # Let's get exact surrounding.
print('Need to manually insert at correct indent. We will use edit with exact text.')
print('Finder found at', pos)

with open('src/renderer/components/ProjectSidebar.tsx','w',encoding='utf-8') as f:
    f.write(content)
