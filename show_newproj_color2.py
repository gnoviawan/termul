with open('src/renderer/components/NewProjectModal.tsx','r',encoding='utf-8') as f:
    lines = f.readlines()
# find map start and print from there
for i, line in enumerate(lines):
    if 'availableColors.map' in line:
        start = i
        break
# print lines start-20?
for j in range(start, min(start+25, len(lines))):
    print(f'{j+1:4d}: {repr(lines[j])}')
