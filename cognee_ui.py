"""
cognee_ui.py — GrandmaCare's MEMORY SERVER + doctor view, in one command.

This launches BOTH halves of Cognee's local stack together:
  • backend  → http://localhost:8000  (FastAPI; the ONLY process that opens
               the ./.cognee/ store — kuzu is single-process, so everything
               else must go through this server over HTTP)
  • frontend → http://localhost:3000  (the web UI doctors/caretakers browse:
               knowledge graph, search, datasets)

⚠️  This MUST be running for the agent's memory to work: the agent (app.py,
port 7777) reaches cognee through the MCP proxy (port 8001), which forwards
every call to this backend. Start order:

    1) uv run cognee_ui.py
    2) uv run cognee_mcp.py
    3) uv run app.py

First run only: it downloads the cognee frontend + runs `npm install`
(needs Node.js — same toolchain Expo uses). Cached after that.
"""

import os
import time
import signal

# Provider/storage env config — MUST come before any cognee import so the
# backend subprocess inherits it and opens the app's ./.cognee/ store.
import cognee_config  # noqa: F401

import cognee

# Keep the UI cache OFF the C: drive. cognee hardcodes it to
# Path.home()/.cognee/ui-cache with no override — but Path.home() reads
# USERPROFILE on Windows, so pointing it (plus npm's cache) at this repo
# puts the frontend + node_modules on D:. Scoped to this process only.
_HERE = os.path.dirname(os.path.abspath(__file__))
fake_home = os.path.join(_HERE, ".cognee_home")
os.makedirs(fake_home, exist_ok=True)
os.environ["USERPROFILE"] = fake_home
os.environ["HOME"] = fake_home
os.environ["NPM_CONFIG_CACHE"] = os.path.join(fake_home, "npm-cache")

# Use PNPM instead of npm (same package manager as the phone project).
# cognee hardcodes `npm install` / `npm run dev`, but on Windows it runs them
# with shell=True — which resolves npm via PATH. So we drop a tiny npm.cmd
# shim that forwards every npm call to pnpm, and put it FIRST on PATH for
# this process only. (`pnpm install` / `pnpm run dev` accept the same args.)
_shim_dir = os.path.join(fake_home, "npm-shim")
os.makedirs(_shim_dir, exist_ok=True)
with open(os.path.join(_shim_dir, "npm.cmd"), "w", encoding="ascii") as f:
    f.write("@echo off\r\npnpm %*\r\n")
os.environ["PATH"] = _shim_dir + os.pathsep + os.environ.get("PATH", "")

# pnpm blocks dependency postinstall scripts it hasn't been approved to run
# (sharp, unrs-resolver) — a warning on pnpm 10, but a hard install failure
# (ERR_PNPM_IGNORED_BUILDS) on pnpm 11. The interactive `pnpm approve-builds`
# can't run inside cognee's subprocess, so approve via env config instead.
# pnpm 10 reads the npm_config_* prefix; pnpm 11 ONLY reads pnpm_config_*
# (it stopped reading npm_config_* entirely) — set both. Process-scoped.
os.environ["npm_config_dangerously_allow_all_builds"] = "true"
os.environ["PNPM_CONFIG_DANGEROUSLY_ALLOW_ALL_BUILDS"] = "true"

# Tell the frontend where the backend is. start_ui passes backend_port to the
# backend but never to the frontend, which reads this env var (default is
# already 8000 — set explicitly so it can't drift).
os.environ["NEXT_PUBLIC_LOCAL_API_URL"] = "http://localhost:8000"
os.environ["NEXT_PUBLIC_IS_CLOUD_ENVIRONMENT"] = "false"  # local mode, not cloud

if __name__ == "__main__":
    # Guard: our backend needs port 8000 free. If something already answers
    # there (a stale/zombie backend from a previous run), starting another
    # would fight over the kuzu store → "Could not set lock (Error: 33)".
    import urllib.error
    import urllib.request

    try:
        urllib.request.urlopen("http://localhost:8000/", timeout=1)
        port_8000_busy = True
    except urllib.error.HTTPError:
        port_8000_busy = True  # any HTTP status = something IS listening
    except OSError:
        port_8000_busy = False  # connection refused/timeout = port free

    if port_8000_busy:
        print(
            "⚠️  Port 8000 is already in use — probably a leftover cognee\n"
            "   backend from a previous run. Close it first (check your\n"
            "   terminals / Task Manager), then start this again.\n"
        )

    child_pids = []
    server = cognee.start_ui(
        pid_callback=child_pids.append,
        port=3000,
        open_browser=True,
        start_backend=True,
        # 8000: the cognee default. The MCP proxy (8001) and anything else
        # reach the store through this backend; app.py lives on 7777.
        backend_port=8000,
    )

    if server:
        print("UI available at http://localhost:3000  (Ctrl+C to stop)")
        print("Backend (memory server) at http://localhost:8000")
        try:
            while server.poll() is None:
                time.sleep(1)
        except KeyboardInterrupt:
            server.terminate()
            server.wait()
            for pid in child_pids:
                if pid != server.pid:
                    try:
                        os.kill(pid, signal.SIGTERM)
                    except OSError:
                        pass
    else:
        print("Failed to start the UI server.")
