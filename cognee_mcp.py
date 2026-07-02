"""
cognee_mcp.py — starts the cognee-mcp proxy so you don't have to remember
the uvx incantation.

It exposes Cognee's tools (remember / recall / search ...) as an MCP server
on http://localhost:8001/mcp and forwards every call to the cognee backend
on :8000 (started by cognee_ui.py). In --api-url mode it is a pure HTTP
client — it never opens the ./.cognee/ store itself, so it can't trigger
the kuzu single-process lock (Error: 33).

Runs via uvx in an ISOLATED environment on purpose: cognee-mcp pins its own
cognee version, and installing it into this project's venv could clobber
our cognee 1.2.2.

Run:  uv run cognee_mcp.py   (after cognee_ui.py is up)
"""

import subprocess
import sys
import urllib.error
import urllib.request

CMD = [
    "uvx",
    "cognee-mcp",
    "--transport", "http",           # streamable-http; clients hit /mcp
    "--host", "127.0.0.1",
    "--port", "8001",                # 8000 = cognee backend, 7777 = app.py
    "--api-url", "http://localhost:8000",
    "--no-migration",                # pure proxy: never touch local DBs
]

if __name__ == "__main__":
    # Friendly heads-up if the memory server isn't up yet (the proxy still
    # starts fine — it just has nothing to forward to until 8000 exists).
    try:
        urllib.request.urlopen("http://localhost:8000/health", timeout=1)
    except urllib.error.HTTPError:
        pass  # got an HTTP response = backend is listening
    except OSError:
        print(
            "⚠️  Nothing answering on http://localhost:8000 yet — start the\n"
            "   memory server first (uv run cognee_ui.py). Continuing anyway;\n"
            "   the proxy will work as soon as the backend is up.\n"
        )

    print("Starting cognee-mcp proxy on http://localhost:8001/mcp  (Ctrl+C to stop)")
    try:
        raise SystemExit(subprocess.run(CMD).returncode)
    except KeyboardInterrupt:
        pass  # Ctrl+C also reaches the child; just exit quietly
    except FileNotFoundError:
        print("uvx not found — install uv first: https://docs.astral.sh/uv/", file=sys.stderr)
        raise SystemExit(1)
