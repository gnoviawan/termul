with open('src/renderer/components/ProjectSidebar.tsx','r',encoding='utf-8') as f:
    lines = f.readlines()
for i in range(629, 650):
    print(f'{i+1:4d}: {repr(lines[i])}')
