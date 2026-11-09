import re
import os
from collections import defaultdict

with open('/Users/jay/.gemini/antigravity/brain/3a0978d6-13ae-4494-a67d-215555175642/.system_generated/tasks/task-194.log', 'r') as f:
    log = f.read()

deletions = defaultdict(list)
for line in log.splitlines():
    m = re.match(r'^([^:]+)\((\d+),\d+\): error TS1117', line)
    if m:
        filepath = m.group(1)
        lineno = int(m.group(2))
        deletions[filepath].append(lineno)

for filepath, lines in deletions.items():
    if not os.path.exists(filepath): continue
    with open(filepath, 'r') as f:
        content = f.readlines()
    
    # Sort descending to safely delete by index
    for lineno in sorted(set(lines), reverse=True):
        idx = lineno - 1
        print(f"Deleting from {filepath}: {content[idx].strip()}")
        del content[idx]
        
    with open(filepath, 'w') as f:
        f.writelines(content)
