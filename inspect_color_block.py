with open('src/renderer/components/ProjectSidebar.tsx','rb') as f:
    lines = f.readlines()
# find color block
for i, line in enumerate(lines):
    if b'availableColors.map' in line:
        start = i
        break
# print 20 lines from start
for j in range(start, min(start+22, len(lines))):
    print(f'{j+1}: {lines[j].decode("utf-8", errors="replace")!r}  #', ' '.join(f'{b:02x}' for b in lines[j]))
