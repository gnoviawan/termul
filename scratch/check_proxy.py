import os
import re

assets_dir = r"c:\Users\USER\Documents\termul\dist-web\assets"
files = [f for f in os.listdir(assets_dir) if f.startswith("web-index-") and f.endswith(".js")]
filepath = os.path.join(assets_dir, files[0])

with open(filepath, 'r', encoding='utf-8') as f:
    content = f.read()

print("Search for Ab (gitApi proxy):")
for match in re.finditer(r"\bAb\b", content):
    start = max(0, match.start() - 50)
    end = min(len(content), match.end() + 50)
    print(f"Index {match.start()}: {content[start:end]}")
