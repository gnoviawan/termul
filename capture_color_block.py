with open('src/renderer/components/ProjectSidebar.tsx','r',encoding='utf-8') as f:
    lines = f.readlines()
# Find start index of color picker block
start = None
for i, line in enumerate(lines):
    if '{/* Color Picker */}' in line:
        start = i
        break
if start is None:
    print('not found')
    exit()
# Determine the end: locate the second </div> after start with same indent as outer div? We'll just take up to line where we have closing outer div followed by blank and Shell comment.
# We know block ends at line 645 (the second </div>), but we want to capture exactly the block lines we inserted earlier.
end = start
# Find the line that is the closing outer div: look for a line that is exactly '</div>' preceded by same indent as outer indentation.
outer_indent = lines[start+1][:len(lines[start+1]) - len(lines[start+1].lstrip())]
print('Outer indent:', repr(outer_indent))
closing_div_count = 0
for i in range(start+1, len(lines)):
    stripped = lines[i].lstrip()
    if stripped == '</div>':
        indent = lines[i][:len(lines[i]) - len(stripped)]
        if indent == outer_indent:
            closing_div_count += 1
            if closing_div_count == 2:
                end = i
                break
print(f'Block from {start+1} to {end+1}')
block_text = ''.join(lines[start:end+1])
print('---BLOCK START---')
print(repr(block_text))
print('---BLOCK END---')
