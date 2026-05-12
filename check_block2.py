with open('src/renderer/components/ProjectSidebar.tsx','r',encoding='utf-8') as f:
    lines = f.readlines()
start = 629
for i in range(start, min(len(lines), start+20)):
    print(f'{i+1:4d}: {repr(lines[i])}')
