# GrandmaCare — Team Plan

> **The care companion that never forgets.** A multilingual eldercare app where every interaction (prescriptions, symptom chats, missed doses) flows into a **Cognee** health knowledge graph that becomes a doctor-ready medical record. A **MedGemma** specialist advises as the agent's teammate.

**Hackathon:** [Cognee "Build AI that doesn't forget"](https://www.wemakedevs.org/hackathons/cognee) · **Jun 29 – Jul 5, 2026** · Cognee is mandatory.
**Judging:** impact · creativity · technical excellence · **effective use of Cognee's memory APIs** · UX/polish · presentation.

---

## 🏗️ Architecture

```
 Mobile (Expo dev build, Android)
   Chat (text/voice) ─┐
   Meds + call-alarms │  HTTPS (ngrok)
   Health-Wiki view ──┘
        │
 AgentOS (FastAPI) ── TEAM "Care Companion"  (Gemini = friendly leader)
        ├─ Medical Advisor  (MedGemma — English, no tools)   ← symptom reasoning
        └─ Cognee tools: remember / recall / improve / forget
                   │
        Cognee memory  (SQLite + LanceDB + KuzuDB, on disk) = "Health Brain"
                   │
        Doctor / Health-Wiki view  ← the record
```

## 🧩 Stack & model assignment

| Role | Tech | Notes |
|---|---|---|
| Language voice | **Sarvam** | STT (Saaras) + TTS (Bulbul) **only** — no translate |
| Leader / coordinator | **Gemini Flash** | chat, Cognee tool calls, prescription vision, card JSON, **replies in user's language** |
| Memory | **Cognee** (self-hosted, embedded) | SQLite + LanceDB + KuzuDB on disk, Gemini as its LLM |
| Medical advisor | **MedGemma** | Agno Team member; English-only, no tools (Gemini stand-in until swapped) |
| Mobile | **Expo dev build** (React Native, SDK 54) | Notifee call-alarms, expo-audio, expo-speech |

**Multilingual rule:** no translator. Frontend sends a language directive (`Respond only in <lang>`) prepended to the message payload (not shown in the chat bubble); Gemini replies in that language. Record Cognee facts in **English** so the doctor wiki is readable.

---

## ✅ Done (do not redo)
- [x] Mobile app shell: 💊 Meds + 💬 Chat tabs (Expo dev build)
- [x] Chat → Gemini agent (text + image + markdown replies) via AgentOS `/agents/agent/runs`
- [x] Camera/gallery → image to agent
- [x] Medicine cards with editable alarms (custom time or prescription default)
- [x] **Call-style alarm** (Notifee full-screen, rings, Answer → TTS voice) — VERIFIED on device
- [x] Dev build via EAS (cloud); hot-reloads JS, rebuild only for new native libs

---

## 🗒️ Backlog (flat — each ≈ one focused session)

### 🧠 Cognee memory — *the judged core* · `@backend`
- [ ] Install + configure Cognee → SQLite + LanceDB + Kuzu, LLM/embeddings = Gemini; confirm DB files on disk
- [ ] `remember()` / `recall()` smoke test with fake grandma data (`cognee_test.py`)
- [ ] Wrap `remember/recall/improve/forget` as **Agno tools** (dataset = per-grandma id)
- [ ] Decide *what gets remembered*: meds, doses taken/missed, symptoms, vitals, doctor notes
- [ ] `improve()` to link med→symptom→condition; `forget()` for corrections/privacy

### 🤝 Agent team · `@backend`
- [ ] Agno **Team**: Gemini leader (chat + Cognee tools + vision) + advisor member
- [ ] Advisor = Gemini stand-in → A/B swap **MedGemma** later (one-line model change)
- [ ] **Safety guardrails**: advisor informational only, escalate red flags, "see a doctor"
- [ ] Symptom flow: chat → follow-up questions → `remember()` symptoms *(feature #4)*
- [ ] Expose Team via AgentOS `/teams/{id}/runs`

### 📸 Scanning & meds · `@either`
- [ ] Prescription OCR → structured meds JSON (Gemini vision) → real cards, kills `SAMPLE_MEDS` *(feature #1)*
- [ ] Pill/strip/bottle recognition: name/dosage/manufacturer/expiry/uses (Gemini vision) *(feature #3)*
- [ ] Auto-suggest alarm times from extracted schedule; write meds → Cognee

### 🌏 Multilingual + voice (Sarvam) · `@mobile`
- [ ] Sarvam key → **backend proxy route** (keep key off the phone)
- [ ] Language picker → prepend `Respond in <lang>` to payload (not the bubble)
- [ ] Record (expo-audio) → Sarvam STT → text
- [ ] Reply → Sarvam Bulbul TTS → play (replaces expo-speech for Indic; incl. call-alarm voice)

### 📱 Mobile · `@mobile`
- [ ] Point chat at the **team** endpoint (was `/agents/agent/runs`)
- [ ] Fix chat persistence (lift state out of the tab)
- [ ] **Caregiver alerts**: store guardian number; unattended reminder → notify guardian (SMS/Twilio or push) *(feature #5)*
- [ ] **Health Wiki / Doctor view** tab: recalled timeline + summary + shareable export *(the wiki)*

### 🎬 Demo & submission · `@both`
- [ ] Safety/disclaimer copy
- [ ] **Demo video** (the call + multilingual + wiki are the wow moments)
- [ ] README polished — Cognee usage front-and-center
- [ ] Submit + optional blog/social side-tracks (bonus prizes)

---

## 👥 Split (parallel-friendly)
- **Backend dev → backend spine:** Cognee tools + Agno team + safety.
- **Mobile dev → mobile + Sarvam edge:** team-endpoint switch, voice pipeline, caregiver alerts, wiki view.

**Agree these two JSON contracts EARLY so you don't block each other:**
1. **Scan → meds**: `{ name, dose, times[], instructions, manufacturer?, expiry?, uses? }`
2. **Cognee recall → wiki**: shape of the timeline/summary the Health-Wiki view renders.

---

## 📌 Whiteboard features (reconciled)
1. Prescription OCR → cards · 2. Reminder system *(DONE: call-alarm)* · 3. Pill recognition *(Gemini vision, **not** MedGemma)* · 4. AI chatbot symptom follow-ups *(MedGemma reasoning)* · 5. Caregiver alerts to guardian.
**Keep MedGemma to English symptom reasoning only** (no OCR, no tools); OCR/vision → Gemini; record-keeping → Cognee.
