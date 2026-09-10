import os
import sys

tasks_path = "deep-swe/tasks"
if os.path.exists(tasks_path):
    files = os.listdir(tasks_path)
    print(f"Found {len(files)} tasks")
    print("First 10:", files[:10])
else:
    print(f"Path not found: {tasks_path}")
    print("Current dir:", os.getcwd())
    print("Contents:", os.listdir("."))
