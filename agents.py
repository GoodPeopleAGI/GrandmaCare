from uuid import uuid4
from typing import List

from pydantic import BaseModel, Field

from agno.agent import Agent
from agno.models.google import Gemini
from agno.os import AgentOS
from agno.db.in_memory import InMemoryDb
from agno.tools import tool


# ─────────────────────────────────────────────────────────────
# CARD SCHEMA  (must match the mobile app's `Medication` type)
# mobile/App.tsx:  { id, name, dose, times[], instructions, emoji }
#
# This Pydantic model is the CONTRACT. Agno turns it into a JSON
# schema and hands it to Gemini, so the model knows EXACTLY which
# fields to fill when it calls the tool. `id` is missing on purpose
# — the backend generates it (the model shouldn't invent ids).
# ─────────────────────────────────────────────────────────────
class MedicationCard(BaseModel):
    name: str = Field(description="Medicine name, e.g. 'Metformin'")
    dose: str = Field(description="Strength + how much, e.g. '500 mg — 1 tablet'")
    times: List[str] = Field(
        description="When to take it, human-readable 12h times, e.g. ['8:00 AM', '8:00 PM']"
    )
    instructions: str = Field(description="Short plain advice, e.g. 'Take after food'")
    emoji: str = Field(description="One big friendly icon for the card, e.g. '💊'")


# ─────────────────────────────────────────────────────────────
# THE TOOL
# Gemini calls this after it has read a prescription. Whatever this
# function RETURNS gets serialized into the run response under
# `response.tools[]`, which the mobile app reads to fill the Meds tab.
# The backend stays stateless — it never "pushes"; it just answers
# the HTTP request with the cards attached.
#
# @tool just marks this function as callable by the agent. The
# docstring + type hints below ARE the spec the model sees, so keep
# them clear.
#
# show_result=False: do NOT dump the raw return value into the chat
# text (that's the ugly {'name': ...} blob we don't want). The result
# still rides in `response.tools[]` for the app to read; the model just
# writes its own friendly summary instead of echoing the JSON.
# ─────────────────────────────────────────────────────────────
@tool(show_result=False)
def create_medication_cards(cards: List[MedicationCard]) -> dict:
    """Create medicine reminder cards for the app to display.

    Call this once you have read a prescription (or the user lists their
    medicines) and you know the medicines, doses, times, and instructions.
    The app turns each card into a big readable tile with an alarm.

    Args:
        cards: The list of medicines to show, one entry per medicine.
    """
    # Give every card a stable id for the app's list keys, and tolerate
    # Agno handing us either MedicationCard objects or plain dicts.
    out = []
    for c in cards:
        data = c.model_dump() if isinstance(c, MedicationCard) else dict(c)
        data["id"] = uuid4().hex[:8]
        out.append(data)

    # The app looks for exactly this shape in the tool result.
    return {"type": "medication_cards", "cards": out}


# `id="agent"` is what the mobile app puts in the URL:
#   POST /agents/agent/runs
agent = Agent(
    id="agent",
    name="GrandmaCare",
    model=Gemini("gemini-2.5-flash"),
    tools=[create_medication_cards],
    instructions=(
        "You help an elderly person and their caretaker with medicines. "
        "When given a prescription, read it and explain in simple, clear "
        "language what to take, how much, and when.\n"
        "Whenever you identify one or more medicines to take regularly, you "
        "MUST call the `create_medication_cards` tool with them so the app "
        "can show reminder cards. Fill every field; pick a fitting emoji. "
        "After calling it, reply with a short friendly confirmation in plain "
        "language — do NOT repeat the raw card data in your message."
    ),
    markdown=True,
    add_history_to_context=True,
    db=InMemoryDb()
)

agentos = AgentOS(agents=[agent])
app = agentos.get_app()


# ─────────────────────────────────────────────────────────────
# RUN THE SERVER
# `python agents.py` starts uvicorn directly (no separate command).
# host="0.0.0.0" is REQUIRED so your PHONE can reach it over the LAN —
# "localhost" would only be reachable from this PC.
#
# We pass the import string "agents:app" (not the `app` object) so
# reload=True can re-import the module on file changes. That also means
# this file must be runnable as `agents` — run it from the repo root.
# ─────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn

    uvicorn.run("agents:app", host="0.0.0.0", port=8000, reload=True)
