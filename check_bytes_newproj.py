with open('src/renderer/components/NewProjectModal.tsx','rb') as f:
    lines = f.readlines()
# find line with b')' etc
for i, line in enumerate(lines):
    if b'availableColors.map' in line:
        start = i
        break
for j in range(start, min(start+20, len(lines))):
    print(j+1, line[j])
