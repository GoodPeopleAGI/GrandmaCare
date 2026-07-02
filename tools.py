"""
tools.py — medication tools the agent can call.

The Pydantic model is the CONTRACT with the mobile app: Agno turns it into a
JSON schema for the model, and the returned dict rides in `response.tools[]`,
which mobile/App.tsx reads to fill the Meds tab.
(Patient memory is separate — it comes from Cognee over MCP; see agents.py.)
"""

from uuid import uuid4
from typing import List

from pydantic import BaseModel, Field

from agno.tools import tool


# Must match mobile/App.tsx `Medication`: { id, name, dose, times[],
# instructions, emoji }. `id` is missing on purpose — the backend generates
# it (the model shouldn't invent ids).
class MedicationCard(BaseModel):
    name: str = Field(description="Medicine name, e.g. 'Metformin'")
    dose: str = Field(description="Strength + how much, e.g. '500 mg — 1 tablet'")
    times: List[str] = Field(
        description="When to take it, human-readable 12h times, e.g. ['8:00 AM', '8:00 PM']"
    )
    instructions: str = Field(description="Short plain advice, e.g. 'Take after food'")
    emoji: str = Field(description="One big friendly icon for the card, e.g. '💊'")


# show_result=False: don't echo the raw JSON into the chat text; the result
# still rides in `response.tools[]` for the app to read.
@tool(show_result=False)
def create_medication_cards(cards: List[MedicationCard]) -> dict:
    """Create medicine reminder cards for the app to display.

    Call this once you have read a prescription (or the user lists their
    medicines) and you know the medicines, doses, times, and instructions.
    The app turns each card into a big readable tile with an alarm.

    Args:
        cards: The list of medicines to show, one entry per medicine.
    """
    out = []
    for c in cards:
        data = c.model_dump() if isinstance(c, MedicationCard) else dict(c)
        data["id"] = uuid4().hex[:8]
        out.append(data)

    # The app looks for exactly this shape in the tool result.
    return {"type": "medication_cards", "cards": out}
