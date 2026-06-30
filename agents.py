import json
import logging
import os
import re
import zlib
from uuid import uuid4
from typing import List

from fastapi import File, HTTPException, UploadFile, status
from pydantic import BaseModel, Field

from agno.agent import Agent
from agno.models.google import Gemini
from agno.os import AgentOS
from agno.db.in_memory import InMemoryDb
from agno.tools import tool
from google import genai
from google.genai import types


logger = logging.getLogger(__name__)

MAX_PILL_IMAGE_BYTES = 8 * 1024 * 1024
SUPPORTED_PILL_IMAGE_MIME_TYPES = {
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/heic",
    "image/heif",
}


class PillRecognitionResult(BaseModel):
    medicine_name: str = Field(description="Medicine name printed on the package")
    dosage_strength: str = Field(description="Dosage or strength printed on the package")
    manufacturer: str = Field(description="Manufacturer printed on the package")
    expiry_date: str = Field(description="Expiry date printed on the package")
    uses: str = Field(description="Uses printed on, or directly inferable from, the package")


class PillRecognitionResponse(BaseModel):
    type: str = Field(default="pill_recognition")
    medicine: PillRecognitionResult


def _detect_image_mime_type(data: bytes) -> str | None:
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "image/webp"
    if len(data) >= 12 and data[4:8] == b"ftyp":
        brand = data[8:12]
        if brand in {b"heic", b"heix", b"hevc", b"hevx", b"mif1", b"msf1"}:
            return "image/heic"
    return None


def _has_valid_image_container(data: bytes, mime_type: str) -> bool:
    if mime_type == "image/jpeg":
        return len(data) > 32 and data.startswith(b"\xff\xd8\xff") and data.endswith(b"\xff\xd9")

    if mime_type == "image/png":
        pos = 8
        seen_ihdr = False
        while pos + 12 <= len(data):
            chunk_len = int.from_bytes(data[pos : pos + 4], "big")
            chunk_type = data[pos + 4 : pos + 8]
            chunk_data_start = pos + 8
            chunk_data_end = chunk_data_start + chunk_len
            crc_end = chunk_data_end + 4
            if chunk_data_end > len(data) or crc_end > len(data):
                return False
            expected_crc = int.from_bytes(data[chunk_data_end:crc_end], "big")
            actual_crc = zlib.crc32(chunk_type + data[chunk_data_start:chunk_data_end]) & 0xFFFFFFFF
            if expected_crc != actual_crc:
                return False
            if chunk_type == b"IHDR":
                seen_ihdr = True
            if chunk_type == b"IEND":
                return seen_ihdr
            pos = crc_end
        return False

    if mime_type == "image/webp":
        return len(data) >= 30 and int.from_bytes(data[4:8], "little") + 8 <= len(data)

    if mime_type == "image/heic":
        return len(data) >= 12 and int.from_bytes(data[0:4], "big") <= len(data)

    return False


def _strip_json_fence(text: str) -> str:
    match = re.search(r"```(?:json)?\s*(.*?)\s*```", text, re.DOTALL | re.IGNORECASE)
    return match.group(1) if match else text.strip()


async def _read_valid_pill_image(file: UploadFile) -> tuple[bytes, str]:
    data = await file.read(MAX_PILL_IMAGE_BYTES + 1)

    if not data:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Uploaded image is empty.",
        )

    if len(data) > MAX_PILL_IMAGE_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="Image is too large. Maximum size is 8 MB.",
        )

    detected_mime_type = _detect_image_mime_type(data)
    if detected_mime_type not in SUPPORTED_PILL_IMAGE_MIME_TYPES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid or unsupported image. Use JPEG, PNG, WEBP, HEIC, or HEIF.",
        )

    if not _has_valid_image_container(data, detected_mime_type):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Uploaded file is not a valid image.",
        )

    if file.content_type and file.content_type not in {
        *SUPPORTED_PILL_IMAGE_MIME_TYPES,
        "application/octet-stream",
    }:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="Unsupported image format. Use JPEG, PNG, WEBP, HEIC, or HEIF.",
        )

    return data, detected_mime_type


def _recognize_pill_with_gemini(image_bytes: bytes, mime_type: str) -> PillRecognitionResult:
    api_key = os.getenv("GOOGLE_API_KEY")
    if not api_key:
        logger.error("Pill recognition failed: GOOGLE_API_KEY is not configured")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Gemini is not configured on the server.",
        )

    prompt = """
You are reading a real medicine strip, medicine bottle, or medicine box image.
Extract ONLY these fields:
- Medicine Name
- Dosage / Strength
- Manufacturer
- Expiry Date
- Uses

Return one JSON object only, with exactly these snake_case keys:
{
  "medicine_name": string,
  "dosage_strength": string,
  "manufacturer": string,
  "expiry_date": string,
  "uses": string
}

Rules:
- Do not add any fields.
- Do not include markdown or explanatory text.
- If a field is not visible or cannot be confidently read, use "Unknown".
- Do not guess hidden details.
"""

    try:
        client = genai.Client(api_key=api_key)
        response = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=[
                types.Part.from_bytes(data=image_bytes, mime_type=mime_type),
                prompt,
            ],
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                temperature=0,
            ),
        )
        payload = json.loads(_strip_json_fence(response.text or "{}"))
        return PillRecognitionResult.model_validate(payload)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Pill recognition failed")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Could not recognize medicine information from the image.",
        ) from exc


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


@app.post("/pill-recognition", response_model=PillRecognitionResponse)
async def recognize_pill(image: UploadFile = File(...)) -> PillRecognitionResponse:
    image_bytes, mime_type = await _read_valid_pill_image(image)
    medicine = _recognize_pill_with_gemini(image_bytes, mime_type)
    return PillRecognitionResponse(medicine=medicine)


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
