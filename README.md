# GrandmaCare 👵💊

**The care companion that never forgets.** Every chat, every scanned
prescription, every "I felt dizzy today" flows into a **[Cognee](https://www.cognee.ai/)**
health **knowledge graph** — so a scattered stream of daily moments quietly
becomes a **connected, doctor-ready medical record**. Cognee links each medicine,
dose, symptom and date into one graph, so the app can answer *"what has she been
on, and how has she felt since?"* — the kind of question a paper pillbox and a
worried memory can never answer. Medicines also become big, readable cards with
**call-style alarms** that ring like an incoming phone call and speak the reminder
aloud.

Built for the [Cognee "Build AI that doesn't forget" hackathon](https://www.wemakedevs.org/hackathons/cognee).

---

## Why

Elderly patients and their caregivers struggle to track medicines and symptoms
over weeks and months, and that history rarely makes it to the doctor.
GrandmaCare turns ordinary daily chats into a **persistent, queryable health
memory** — and reminds in a friendly voice that's hard to miss.

## What it does today

- 🧠 **A health record that builds itself (Cognee)** — the heart of the app. Every
  detail — a medicine, a dose change, a symptom, a rough night — is written into
  Cognee's **graph + vector** memory with `remember`, and any question is answered
  from that record with `recall`. Because it's a **graph**, facts don't just pile
  up — they *connect*: this medicine ↔ that side-effect ↔ the day it started. That
  connected history is what makes a patient's health genuinely *trackable* over
  weeks and months. See [How Cognee is used](#how-cognee-is-used).
- 📸 **Prescription & pill scanning** — snap a prescription, strip, or bottle
  (camera or gallery); the multimodal model (`gemma4:31b-cloud`) reads the
  medicine, dose, and schedule, turns it into cards, **and files it into the
  memory graph** so it's part of the record forever.
- 💬 **AI health chat** — a warm companion the patient or caretaker talks to.
  Every health detail it hears is saved to the graph automatically.
- 💊 **Medication cards** — prescriptions and regular medicines become large,
  readable tiles (name, dose, times, instructions) with a per-card **Scan
  medicine** button.
- 📞 **Call-style alarms** — full-screen, ringing reminders you "answer" to hear
  the medicine spoken aloud (Notifee + on-device TTS). Verified on-device.
- 🩺 **Doctor view** — the accumulated record is browsable as a live **knowledge
  graph** and searchable in the Cognee web UI (runs on the caretaker's laptop).

### Roadmap (not yet shipped)

- 🌏 Multilingual replies + voice (Sarvam STT/TTS)
- 🩺 A specialist medical advisor (MedGemma) for symptom reasoning
- 🔔 Caregiver alerts when reminders go unattended
- 🛡️ Pill-safety check — recall allergies/current meds on a scan and warn on
  interactions (graph reasoning over the stored record)

## How Cognee is used

**Cognee's graph storage is what turns "an app grandma talks to" into "a health
record that keeps itself."** A pillbox holds today; a chat app holds one message.
A graph holds the *whole story* and, crucially, the **relationships** in it —
which is exactly what tracking a patient's health requires.

Here's the record building itself over three ordinary days:

```
Day 1  "She started Metformin 500mg after breakfast."
Day 3  "Felt a bit nauseous this morning."
Day 8  "Doctor bumped the Metformin to 1000mg."

              ┌─────────────┐  started 2026-07-01   ┌──────────────┐
              │  Metformin  │──────────────────────►│  the patient │
              │  500→1000mg │  causes? 2026-07-03    │              │
              └─────────────┘◄──────────────────────│   Nausea     │
                     ▲                                └──────────────┘
                     │ dose changed 2026-07-08 (Dr. visit)
```

Now the app can answer questions no flat log could — *"has anything she started
recently lined up with feeling unwell?"* — because the nausea, the drug, and the
dates are **connected nodes**, not three unrelated sentences. Every scan and every
chat adds to this same graph, so the record only ever gets richer. That connected,
longitudinal record is the doctor-ready output — browsable live in the Cognee web
UI.

Memory is the judged core of this project, so it gets its own process and its own
lifecycle:

| Cognee API | Where | What it does here |
|---|---|---|
| `remember` | agent, every health message | Saves dated, third-person facts ("On 2026-07-02: the patient felt dizzy.") |
| `recall` | agent, before answering | Answers history/medicine/safety questions from stored memory only — never invents facts |
| `search` | agent / UI | Graph + vector search over the record |
| graph + vector store | Cognee backend | SQLite (metadata) + LanceDB (vectors) + Kuzu (graph), all on disk |
| web UI | caretaker's laptop | Browse the knowledge graph, search the history |

The agent never imports Cognee directly. It reaches it over **MCP** (Model Context
Protocol) through the stock Agno `MCPTools`, so the model gets a clean, whitelisted
toolset (`remember` / `recall` / `search` — the destructive `forget`/`delete`/`prune`
tools are deliberately withheld). See [Architecture](#architecture) for why that
indirection exists.

## Architecture

Kuzu (the graph store) is **single-process** — only one OS process may open the
`./.cognee/` store at a time. So exactly one process owns it, and everything else
talks to it over HTTP/MCP:

```
 Mobile app (Expo, Android)
   │  HTTPS (ngrok / LAN)
   ▼
 app.py — AgentOS (FastAPI)                         :7777   ← the phone talks here
   │  agent = Ollama gemma4:31b-cloud + tools
   │
   ├─ create_medication_cards            (local tool, tools.py)
   └─ Cognee memory via MCP ─────────────► cognee_mcp.py    :8001
                                             │  (uvx cognee-mcp, pure HTTP proxy)
                                             ▼
                                           cognee_ui.py               :8000  ← owns ./.cognee/
                                             ├─ Cognee backend (store owner)
                                             └─ Cognee web UI (doctor view)   :3000

 Models (local Ollama daemon, :11434):
   LLM        gemma4:31b-cloud   (Ollama Cloud free tier, proxied via localhost)
   Embeddings embeddinggemma:300m (runs locally — private + unlimited)
```

Why three processes: if the agent opened the store *and* the UI backend opened it,
they'd fight over Kuzu's file lock (`Could not set lock … Error: 33`) and datasets
would get stuck "processing". One owner (`cognee_ui.py` on :8000), everyone else an
HTTP/MCP client, avoids that entirely.

## Repo structure

```
.
├── app.py            # AgentOS server (the phone talks to this)          :7777
├── agents.py         # the agent: model, tools, instructions
├── tools.py          # create_medication_cards (local tool)
├── cognee_config.py  # Cognee providers + storage config (env only)
├── cognee_ui.py      # Cognee backend + web UI — owns ./.cognee/    :8000 + :3000
├── cognee_mcp.py     # cognee-mcp proxy launcher (uvx)                   :8001
├── cognee_test.py    # standalone Cognee smoke test (run alone)
├── pyproject.toml    # deps (uv); requirements.txt is generated from this
├── mobile/           # Expo React Native app (dev build)
└── README.md
```

## Tech stack

**Backend:** Python 3.11–3.13 · [uv](https://docs.astral.sh/uv/) ·
[Agno](https://docs.agno.com/) AgentOS · [Ollama](https://ollama.com/)
(`gemma4:31b-cloud` LLM + `embeddinggemma:300m` embeddings) ·
[Cognee](https://docs.cognee.ai/) (SQLite + LanceDB + Kuzu) · MCP

**Mobile:** React Native · Expo (SDK 54, dev build) · Notifee (call-alarms) ·
expo-speech · expo-image-picker

---

## Getting started

### Prerequisites

- [**uv**](https://docs.astral.sh/uv/getting-started/installation/) — Python
  toolchain (also provides `uvx`, used to run cognee-mcp).
- [**Ollama**](https://ollama.com/download), signed in for the cloud model, with
  the embedding model pulled locally:
  ```bash
  ollama pull embeddinggemma:300m
  # gemma4:31b-cloud runs on Ollama Cloud via your signed-in daemon (no local pull)
  ```
- **Node.js** — Cognee's web UI runs `npm install` on first launch.
- For the mobile app: Node 18+, [pnpm](https://pnpm.io/installation), an
  [Expo account](https://expo.dev/signup), and EAS CLI (`npm i -g eas-cli`).

### Backend

```bash
# 1. Create the venv and install pinned deps from the lockfile
uv sync

# 2. Start the three processes, each in its OWN terminal, IN THIS ORDER:

#    Terminal 1 — memory server + doctor UI (owns the store; start this FIRST)
uv run cognee_ui.py          # → backend :8000, web UI :3000

#    Terminal 2 — cognee-mcp proxy (bridges the agent to the memory server)
uv run cognee_mcp.py         # → MCP on http://localhost:8001/mcp

#    Terminal 3 — the agent server the phone talks to
uv run app.py                # → AgentOS on :7777
```

> **Order matters.** `cognee_mcp.py` and `app.py` both point at the memory server,
> so start `cognee_ui.py` first. (The agent re-checks its MCP connection each run,
> so a late start self-heals — but clean order avoids a tools-less first boot.)

Expose the agent to your phone with **ngrok** (tunnel **7777**, not 8000):

```bash
ngrok http 7777
```

Put the `https://….ngrok-free.app` URL into `mobile/.env` (see below).

> **Dependencies:** managed via `pyproject.toml` + `uv.lock`. Add a dep with
> `uv add <pkg>`; `requirements.txt` (for non-uv users) is regenerated with
> `uv export --no-hashes --no-emit-project -o requirements.txt`.

### Mobile (Expo dev build)

```bash
cd mobile
pnpm install

# Point the app at your backend — create mobile/.env (see mobile/.env.example):
#   EXPO_PUBLIC_AGENT_OS_URL=https://<your-ngrok>.ngrok-free.app
# or your LAN IP: http://192.168.1.50:7777  (NOT localhost — the phone is a
# different device). Find your IP with `ipconfig`.

# Build the dev client ONCE — call-style alarms (Notifee) can't run in Expo Go.
eas build --profile development --platform android

# Then day-to-day just start the dev server and open "GrandmaCare (dev)":
pnpm start
```

You only **rebuild** when adding a native library or changing `app.json`; pure-JS
changes hot-reload like Expo Go.

## ⚠️ Disclaimer

GrandmaCare is **informational only** and **not a medical device**. It does not
diagnose, treat, or replace a doctor. Always consult a healthcare professional. In
an emergency, call local emergency services.
