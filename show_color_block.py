with open('src/renderer/components/ProjectSidebar.tsx','r',encoding='utf-8') as f:
    lines = f.readlines()
start = None
for i, line in enumerate(lines):
    if '{/* Color Picker */}' in line:
        start = i
        break
if start is None:
    print('not found')
else:
    print('Start line:', start+1, repr(lines[start]))
    for j in range(start, min(start+30, len(lines))):
        print(f'{j+1}: {repr(lines[j])}')
