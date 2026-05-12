with open('src/renderer/components/NewProjectModal.tsx','rb') as f:
    lines = f.readlines()
# locate line containing 'availableColors.map'
for i, line in enumerate(lines):
    if b'availableColors.map' in line:
        start = i
        break
# show raw hex of lines start-20
for j in range(start, min(start+20, len(lines))):
    # show index and hex values
    hex_bytes = ' '.join(f'{b:02x}' for b in lines[j])
    print(f'{j+1}: {lines[j].decode("utf-8", errors="replace")!r}  # {hex_bytes}')
