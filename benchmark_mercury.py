#!/usr/bin/env python
"""
DeepSWE Benchmark Script for Mercury 2.5 (Elia)

Run this script to benchmark Mercury 2.5 on DeepSWE tasks.

Before running, ensure you have:
1. Set the API_KEY environment variable: export API_KEY=your_key
2. Docker installed and running
3. Datacurve-pier installed: uv tool install datacurve-pier

Usage:
    python benchmark_mercury.py
"""

import os
import subprocess
import sys

def run_benchmark(num_tasks=2, seed=42):
    """Run DeepSWE benchmark with Mercury 2.5"""

    api_key = os.getenv("API_KEY")
    if not api_key:
        print("ERROR: API_KEY environment variable not set.")
        print("Please set it: export API_KEY=your_api_key")
        sys.exit(1)

    # Run pier with Mercury 2.5
    cmd = [
        "pier", "run",
        "-p", "deep-swe/tasks",
        "-a", "mini-swe-agent",
        "-m", "openai/mercury-2.5",
        "--agent-env", f"API_KEY={api_key}",
        "--agent-env", "OPENAI_API_KEY=placeholder",
        "--agent-env", "OPENAI_BASE_URL=https://api.mercury.ai/v1",
        "-l", str(num_tasks),
        "--sample-seed", str(seed),
        "--quiet",
    ]

    print(f"Running benchmark with {num_tasks} tasks...")
    print(f"Model: Mercury 2.5 (via OpenAI-compatible API)")
    print(f"Command: {' '.join(cmd)}")
    print()

    result = subprocess.run(cmd, capture_output=True, text=True)

    print(result.stdout)
    print(result.stderr)

    return result.returncode

if __name__ == "__main__":
    # Default to 2 tasks for quick test
    exit_code = run_benchmark(num_tasks=2)
    sys.exit(exit_code)
