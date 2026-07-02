"""
app.py — the GrandmaCare agent server: AgentOS on port 7777.

The agent itself (model, tools, instructions) lives in agents.py. Patient
memory is NOT in this process: the agent's MCP tools call the cognee-mcp
proxy (:8001), which forwards to the cognee backend (:8000, started by
cognee_ui.py — the only process allowed to open the ./.cognee/ store).

Start order (three terminals):
    1) uv run cognee_ui.py     # memory server (8000) + doctor UI (3000)
    2) uv run cognee_mcp.py    # MCP proxy (8001)
    3) uv run app.py           # this file (7777) — point the phone/ngrok here

Run:  python app.py   (or: uv run app.py)
"""

from agno.os import AgentOS

from agents import agent


agentos = AgentOS(agents=[agent])
app = agentos.get_app()


# ─────────────────────────────────────────────────────────────
# RUN THE SERVER — `python app.py`.
# host="0.0.0.0" so the PHONE can reach it over the LAN.
# NO reload: uvicorn's reloader breaks the MCP tools' connect/close
# lifecycle that AgentOS manages in its FastAPI lifespan.
# ─────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app:app", host="0.0.0.0", port=7777)
