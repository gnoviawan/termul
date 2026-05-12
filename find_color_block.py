with open('src/renderer/components/ProjectSidebar.tsx','r',encoding='utf-8') as f:
    lines = f.readlines()

# Find start of color picker block
start_idx = None
for i, line in enumerate(lines):
    if '{/* Color Picker */}' in line:
        start_idx = i
        break
if start_idx is None:
    print('Color picker start not found')
    exit()

# Find the closing outer div: look for the next occurrence of a line that is exactly (with indent) '</div>' that corresponds to outer div. But we know block ends with two consecutive </div>. However we can find the end by counting.
# We know the structure: <div className="space-y-2 mt-4"> (line start) then ... then <div className="flex gap-2"> then map then close of that inner div (first </div>) then close outer div (second </div>).
# Let's identify: we'll locate the second </div> after start that appears at same indentation as opening outer div.
# The outer div line is at start_idx+1 (should be '<div className="space-y-2 mt-4">').
outer_indent = ''
for ch in lines[start_idx+1]:
    if ch in ' \t':
        outer_indent += ch
    else:
        break
print('Outer indent:', repr(outer_indent))

# Now find second </div> with that same indent
closing_count = 0
end_idx = None
for i in range(start_idx+1, len(lines)):
    line = lines[i]
    stripped = line.lstrip()
    if stripped == '</div>':
        # Check indent matches outer_indent?
        indent_actual = line[:len(line)-len(stripped)]
        if indent_actual == outer_indent:
            closing_count += 1
            if closing_count == 2:
                end_idx = i
                break
if end_idx is None:
    print('Could not find second closing div')
    # maybe find manually
else:
    print(f'Block from {start_idx+1} to {end_idx+1}')
    print('Lines:')
    for j in range(start_idx, min(end_idx+2, len(lines))):
        print(f'{j+1}: {repr(lines[j])}')
