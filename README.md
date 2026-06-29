# GrandmaCare 👵💊

**The care companion that never forgets.** A multilingual eldercare app: scan prescriptions, get loud *incoming-call-style* medicine reminders with a spoken voice, chat about symptoms, and have every interaction build a **[Cognee](https://www.cognee.ai/)**-powered health knowledge graph that grows into a doctor-ready medical record.

Built for the [Cognee "Build AI that doesn't forget" hackathon](https://www.wemakedevs.org/hackathons/cognee).

---

## Why
Elderly patients (and their caregivers) struggle to track medicines and symptoms over time, and that history rarely reaches the doctor. GrandmaCare turns daily interactions into a **persistent, queryable health memory** — and reminds in the patient's **own language** with a friendly voice that feels like a phone call.

## Features
- 📸 **Prescription & pill scanning** — extract medicine, dosage, schedule (Gemini vision)
- 📞 **Call-style reminders** — full-screen, ringing, "answer" → spoken reminder (Notifee + TTS)
- 💬 **AI chat** — symptom check-ins with medical-specialist reasoning (MedGemma)
- 🧠 **Never-forgetting memory** — Cognee builds a health knowledge graph (`remember/recall/improve/forget`)
- 🌏 **Multilingual** — replies & voice in the user's language (Gemini + Sarvam STT/TTS)
- 🩺 **Doctor wiki** — the accumulated record, summarized and shareable
- 🆘 **Caregiver alerts** — notify a guardian if reminders go unattended

## Architecture
```
Mobile (Expo dev build) ── HTTPS ──> AgentOS (FastAPI)
                                       └─ Agno Team: Gemini leader + MedGemma advisor
                                          └─ Cognee tools (remember/recall/improve/forget)
                                             └─ SQLite + LanceDB + KuzuDB (on disk)
Voice: Sarvam STT/TTS   ·   Language: Gemini replies in user's language
```

## Repo structure
```
.
├── agents.py        # AgentOS backend (Agno team + Gemini + Cognee tools)
├── mobile/          # Expo React Native app (dev build)
├── TEAMPLAN.md      # team backlog & tracking
└── README.md
```

## Tech stack
**Backend:** Python · FastAPI · [Agno](https://docs.agno.com/) AgentOS · Google Gemini · MedGemma · [Cognee](https://docs.cognee.ai/) (SQLite + LanceDB + KuzuDB)
**Mobile:** React Native · Expo (SDK 54, dev build) · Notifee · expo-audio · expo-speech
**Voice/lang:** [Sarvam AI](https://docs.sarvam.ai/) (STT/TTS, 22 Indian languages)

## Getting started

### Backend (Python · [uv](https://docs.astral.sh/uv/))

**Prerequisites:** install `uv` → https://docs.astral.sh/uv/getting-started/installation/

```bash
# 1. From the repo root, create a virtual env and activate it
uv venv
source .venv/bin/activate            # Windows (PowerShell): .venv\Scripts\Activate.ps1

# 2. Install dependencies (fast, with uv)
uv pip install -U "agno[os]" uvicorn google-genai cognee

# 3. Set your API key — Gemini powers BOTH the agent and Cognee's graph extraction
export GOOGLE_API_KEY=your_key       # Windows (PowerShell): $env:GOOGLE_API_KEY="your_key"

# 4. Run the API. host 0.0.0.0 is REQUIRED so your phone can reach it over the network
uvicorn agents:app --host 0.0.0.0 --port 8000
```

Verify it's up: open <http://localhost:8000/docs> in a browser.

Expose it to your phone (works on any network) with **ngrok** in a second terminal:
```bash
ngrok http 8000
```
Copy the `https://….ngrok-free.app` URL it prints into `mobile/.env` (next section).

> **Tip:** add new deps with `uv pip install <pkg>`. To freeze a lockfile for your teammate: `uv pip freeze > requirements.txt` (then they run `uv pip install -r requirements.txt`).

### Mobile (React Native · Expo dev build)

**Prerequisites:** Node 18+, [pnpm](https://pnpm.io/installation), a free [Expo account](https://expo.dev/signup), and the EAS CLI (`npm install -g eas-cli`, then `eas login`).

```bash
cd mobile

# 1. Install JS dependencies
pnpm install

# 2. Point the app at your backend — create mobile/.env (NOT committed):
#      EXPO_PUBLIC_AGENT_OS_URL=https://<your-ngrok>.ngrok-free.app

# 3. Build the development client ONCE — alarms (Notifee) can't run in Expo Go.
#    Cloud build, ~10–20 min on the free tier; install the APK it gives you:
eas build --profile development --platform android

# 4. Start the dev server, then open the "GrandmaCare (dev)" app on your phone
pnpm start
```

**Day-to-day (after the first build):** just `pnpm start` and reload — JS changes hot-reload exactly like Expo Go. You only **rebuild** when you add a new **native** library or change `app.json` (permissions/plugins). Pure-JS libraries and all UI/logic changes need no rebuild.

## ⚠️ Disclaimer
GrandmaCare is **informational only** and **not a medical device**. It does not diagnose, treat, or replace a doctor. Always consult a healthcare professional. In an emergency, call local emergency services.
