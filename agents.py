"""
agents.py — the GrandmaCare agent and all its config.

Just the agent: model, tools, instructions, storage. Medication-card tools
live in tools.py; patient memory comes from Cognee over MCP (the cognee-mcp
proxy on :8001 forwards to the cognee backend on :8000 — see cognee_ui.py).
The server that exposes the agent lives in app.py (port 7777).
"""

from agno.agent import Agent
from agno.models.ollama import Ollama
from agno.db.sqlite import SqliteDb
from agno.tools.mcp import MCPTools

from tools import create_medication_cards


# Cognee memory over MCP. AgentOS connects/closes this in its own FastAPI
# lifespan — do NOT call connect() manually, and do NOT run uvicorn with
# reload=True (it breaks the MCP connection lifecycle).
cognee_memory = MCPTools(
    transport="streamable-http",
    url="http://localhost:8001/mcp",
    # Whitelist: read/write only. The destructive cognee tools (forget,
    # delete, prune, ...) are deliberately NOT exposed to the model — one
    # hallucinated call could wipe the whole health record.
    include_tools=["remember", "recall", "search"],
    # Re-ping and re-list tools each run, so an MCP proxy restart (or it
    # starting after app.py) doesn't leave the agent memory-less.
    refresh_connection=True,
    timeout_seconds=30,
)


# `id="agent"` is what the mobile app puts in the URL: POST /agents/agent/runs
agent = Agent(
    id="agent",
    name="GrandmaCare",
    # Gemma 4 on Ollama Cloud (free tier) via the signed-in local daemon —
    # no API key, no per-day request quota. Same model the cognee backend uses.
    # Low temperature: mid-size open models emit malformed tool-call JSON at
    # higher temps — this is the single biggest tool-reliability lever we have.
    model=Ollama(id="gemma4:31b-cloud", options={"temperature": 0.2}),
    tools=[
        create_medication_cards,
        cognee_memory,
    ],
    debug_mode=True,
    # Step-ordered + few-shot: small models follow a numbered procedure with
    # examples far more reliably than prose guidelines.
    instructions=(
        "You are GrandmaCare, a warm health companion for an elderly person and "
        "their caretaker. On EVERY message, work through these steps IN ORDER:\n"
        "\n"
        "STEP 1 — SAVE health facts (tool: remember). If the message mentions ANY "
        "of these — a medicine (name, dose, or schedule), a symptom, pain, mood or "
        "how they feel, sleep, meals or appetite, a condition or diagnosis, an "
        "allergy, a doctor visit or appointment — you MUST call `remember` BEFORE "
        "writing your reply. Put ALL facts from the message into one call, written "
        "as short third-person sentences that start with today's date.\n"
        "Examples:\n"
        "  User: 'I take metformin 500mg after breakfast' → "
        "remember(data=\"On 2026-07-02: The patient takes Metformin 500mg daily after breakfast.\")\n"
        "  User: 'felt dizzy again and skipped lunch' → "
        "remember(data=\"On 2026-07-02: The patient felt dizzy again. The patient skipped lunch.\")\n"
        "(Always use TODAY'S real date from the context — the dates above are just examples.)\n"
        "If the message has NO health content at all (pure greeting or thanks), skip this step.\n"
        "\n"
        "STEP 2 — LOOK UP before answering (tool: recall). If the user asks "
        "anything about their health, history, medicines, allergies, schedules, or "
        "whether something is safe for them, call `recall` with a clear question "
        "and base your answer ONLY on what it returns. If it returns nothing "
        "relevant, say you have no record of it — never invent medical facts.\n"
        "\n"
        "STEP 3 — MEDICATION CARDS (tool: create_medication_cards). When a "
        "prescription is shared or a regularly-taken medicine is identified, you "
        "MUST call `create_medication_cards` (fill every field; pick a fitting "
        "emoji) AND also save each medicine via STEP 1. After the call, reply with "
        "one short friendly confirmation — never repeat the raw card data.\n"
        "\n"
        "STEP 4 — REPLY in plain, warm, simple language: short sentences, no "
        "jargon, no technical talk about tools or saving. Just be kind and clear."
    ),
    markdown=True,
    add_history_to_context=True,
    # Gives the model today's date so remembered facts are dated (STEP 1) —
    # that's what makes symptom timelines queryable in the graph later.
    add_datetime_to_context=True,
    # SQLite so conversations SURVIVE a server restart; keyed by the
    # user_id + session_id the mobile app sends with each run.
    db=SqliteDb(db_file="grandmacare.db"),
)
