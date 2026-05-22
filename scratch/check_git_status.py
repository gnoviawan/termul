import os

path = "c:/Users/USER/Documents/termul/dist-web/assets/web-index-D-PNBWfO.js"
with open(path, "r", encoding="utf-8") as f:
    content = f.read()

idx = 0
while True:
    idx = content.find("git_get_status", idx)
    if idx == -1:
        break
    print("Found git_get_status at index:", idx)
    start = max(0, idx - 200)
    end = min(len(content), idx + 200)
    print("Context:")
    print(content[start:end])
    print("-" * 50)
    idx += len("git_get_status")
