with open('src/renderer/components/ProjectSidebar.tsx','r',encoding='utf-8') as f:
    lines = f.readlines()
# indices: line642 index 641 (self-close)
# line643 index 642
# line644 index 643
# line645 index 644
old_slice = ''.join(lines[642:645])  # lines 643-645 (indices 642,643,644)
print('Old slice repr:')
print(repr(old_slice))
# Also get indentation for line630 and line628
indent630 = lines[629][:len(lines[629])-len(lines[629].lstrip())]
indent628 = lines[627][:len(lines[627])-len(lines[627].lstrip())]
print('indent630:', repr(indent630), 'len', len(indent630))
print('indent628:', repr(indent628), 'len', len(indent628))
