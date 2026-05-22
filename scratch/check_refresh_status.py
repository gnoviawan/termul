import os

path = "c:/Users/USER/Documents/termul/dist-web/assets/web-index-D-PNBWfO.js"
with open(path, "r", encoding="utf-8") as f:
    content = f.read()

idx = content.find("refreshStatus")
while idx != -1:
    print("Found refreshStatus at index:", idx)
    start = max(0, idx - 200)
    end = min(len(content), idx + 200)
    print(content[start:end])
    print("-" * 50)
    idx = content.find("refreshStatus", idx + 1)
