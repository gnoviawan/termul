with open('src/renderer/components/ProjectSidebar.tsx','rb') as f:
    lines = f.readlines()
for i in range(623, 648):
    line = lines[i]
    # show hex of first 20 bytes
    print(f'{i+1:4d}:', ' '.join(f'{b:02x}' for b in line[:30]), line.decode('utf-8', errors='replace'), end='')
