with open('src/renderer/components/NewProjectModal.tsx','r',encoding='utf-8') as f:
    lines = f.readlines()
# find line with "})}" pattern
for i, line in enumerate(lines):
    if '})}' in line or ')})' in line:
        print(i+1, repr(line))
# Also print around that line
for i, line in enumerate(lines):
    if i>=178 and i<=195:
        print(f'{i+1}: {repr(line)}')
