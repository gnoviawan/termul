with open('src/renderer/components/NewProjectModal.tsx','r',encoding='utf-8') as f:
    lines = f.readlines()
for i, line in enumerate(lines):
    if 'availableColors.map' in line:
        start = i
        break
# Show the specific line numbers around closure
for j in range(start, start+20):
    print(f'{j+1}: {lines[j]}', end='')
