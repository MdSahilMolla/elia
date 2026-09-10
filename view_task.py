import os

task_id = "abs-module-cache-flags"
task_path = f"deep-swe/tasks/{task_id}"

if os.path.exists(task_path):
    print(f"Task: {task_id}")
    print("Contents:")
    for f in os.listdir(task_path):
        filepath = os.path.join(task_path, f)
        if os.path.isfile(filepath):
            if f == "instruction.md":
                content = open(filepath).read()
                print(f"\n=== {f} ===")
                print(content[:600])
else:
    print(f"Task {task_id} not found")
