# Read file
with open('src/renderer/components/ProjectSidebar.tsx','r',encoding='utf-8') as f:
    lines = f.readlines()

# indices
idx_self_close = 641   # line 642: < />
idx_start_slice = 642  # line 643: currently ')}'   (this will be replaced)
idx_line644 = 643      # line 644: first </div>
idx_line645 = 644      # line 645: second </div>

# Get indent strings
indent630 = lines[629][:len(lines[629]) - len(lines[629].lstrip())]   # line 630 (return () line)
indent628 = lines[627][:len(lines[627]) - len(lines[627].lstrip())]   # line 628 (map start)

# Build new lines
new_lines_list = []  # will hold replacement slice (4 lines)
# line 1: indent630 + ')'
new_lines_list.append(indent630 + ')\n')
# line 2: indent628 + '})}'
new_lines_list.append(indent628 + '})}\n')
# line 3 and 4: existing closing div lines
new_lines_list.append(lines[idx_line644])  # </div> (inner flex)
new_lines_list.append(lines[idx_line645])  # </div> (outer)

# Replace lines idx_start_slice..idx_line645 inclusive with new_lines_list
new_lines = lines[:idx_start_slice] + new_lines_list + lines[idx_line645+1:]

# Write back
with open('src/renderer/components/ProjectSidebar.tsx','w',encoding='utf-8') as f:
    f.writelines(new_lines)

print('Replaced lines', idx_start_slice+1, 'to', idx_line645+1, 'with', len(new_lines_list), 'lines')
# verify around
for i in range(idx_start_slice-2, idx_start_slice+len(new_lines_list)+2):
    print(i+1, repr(new_lines[i]))
