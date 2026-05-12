with open('src/renderer/components/ProjectSidebar.tsx','r',encoding='utf-8') as f:
    lines = f.readlines()
indent628 = lines[627][:len(lines[627])-len(lines[627].lstrip())]
indent630 = lines[629][:len(lines[629])-len(lines[629].lstrip())]
print('len628', len(indent628), 'len630', len(indent630))
