with open('src/renderer/components/ProjectSidebar.tsx','r',encoding='utf-8') as f:
    lines = f.readlines()
# line index 629 is line 630 (0-based index)
line630 = lines[629]  # line number 630
print(repr(line630[:50]))
# indent part:
indent630 = line630[:len(line630)-len(line630.lstrip())]
print('Indent for line 630:', repr(indent630))

# Now line 628 (index 627) is map start
line628 = lines[627]
indent628 = line628[:len(line628)-len(line628.lstrip())]
print('Indent for line 628:', repr(indent628))

# also line 642 (index 641) is '/>'
line642 = lines[641]
print('Line642:', repr(line642))
