with open('src/renderer/components/NewProjectModal.tsx','r',encoding='utf-8') as f:
    lines = f.readlines()
# Find line where availableColors.map start
for i, line in enumerate(lines):
    if 'availableColors.map' in line:
        start = i
        break
else:
    print('not found')
    exit()
# print from start to end of map block, about 15 lines
for j in range(start, min(start+20, len(lines))):
    print(f'{j+1}: {repr(lines[j])}')
