with open('src/renderer/components/ProjectSidebar.tsx','r',encoding='utf-8') as f:
    lines = f.readlines()

# Find Shell Field comment line index
for i, line in enumerate(lines):
    if '{/* Shell Field */}' in line:
        shell_idx = i
        print(f'Shell Field comment at line {i+1}: {repr(line)}')
        break
else:
    print('Not found')
    exit()

# Determine indentation: take leading whitespace of that line
indent = ''
for ch in lines[shell_idx]:
    if ch in ' \t':
        indent += ch
    else:
        break
print(f'Indent: {repr(indent)}')

# Color block lines with indent
color_lines = [
    indent + '{/* Color Picker */}\n',
    indent + '<div className="space-y-2 mt-4">\n',
    indent + '\t<label className="block text-xs font-medium text-muted-foreground mb-1">Color</label>\n',
    indent + '\t<div className="flex gap-2">\n',
    indent + '\t\t{availableColors.map((color) => {\n',
    indent + '\t\t\tconst colors = getColorClasses(color)\n',
    indent + '\t\t\treturn (\n',
    indent + '\t\t\t\t<button\n',
    indent + '\t\t\t\t\tkey={color}\n',
    indent + '\t\t\t\t\ttype="button"\n',
    indent + '\t\t\t\t\tonClick={() => setSettingsColor(color)}\n',
    indent + '\t\t\t\t\tclassName={cn(\n',
    indent + '\t\t\t\t\t\t"w-6 h-6 rounded-full transition-all",\n',
    indent + '\t\t\t\t\t\tcolors.bg,\n',
    indent + '\t\t\t\t\t\tsettingsColor === color\n',
    indent + '\t\t\t\t\t\t\t? "ring-2 ring-offset-2 ring-offset-card ring-current"\n',
    indent + '\t\t\t\t\t\t\t: "hover:opacity-80",\n',
    indent + '\t\t\t\t\t)}\n',
    indent + '\t\t\t\t/>\n',
    indent + '\t\t\t)}\n',
    indent + '\t\t</div>\n',
    indent + '</div>\n',
    '\n',
]

# Insert before shell_idx
new_lines = lines[:shell_idx] + color_lines + lines[shell_idx:]
with open('src/renderer/components/ProjectSidebar.tsx','w',encoding='utf-8') as f:
    f.writelines(new_lines)
print(f'Inserted {len(color_lines)} lines before line {shell_idx+1}')
