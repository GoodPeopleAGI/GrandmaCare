/* GrandmaCare web demo — behavioral clone of mobile/App.tsx.
 *
 * Same backend contract, same localStorage keys as the phone app's
 * storage.ts, same copy. Downgrades vs mobile (by design):
 *   • call-style Notifee alarms → browser Notification + in-page alarm screen
 *   • camera/gallery dialog     → file pickers
 * Served by app.py at /web, so the API is same-origin (base URL '').
 */

'use strict';

// ─────────────────────────────────────────────────────────────
// Storage (mirrors mobile/storage.ts, but on localStorage)
// ─────────────────────────────────────────────────────────────
const STORE = {
  userId: 'gc.userId',
  sessionId: 'gc.sessionId',
  meds: 'gc.meds',
  chat: 'gc.chat',
  backendUrl: 'gc.backendUrl', // web-only: override for cross-origin demos
};

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}
function saveJSON(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}
// Same shape as the phone's ids (NOT a real uuid, matching storage.ts).
function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}
const makeId = () => newId('med').slice(-8);

// ─────────────────────────────────────────────────────────────
// App state
// ─────────────────────────────────────────────────────────────
const AGENT_ID = 'agent';

const SEED_MESSAGES = [
  {
    id: 'seed1', from: 'agent',
    text: "Hi! 👋 I'm your medicine helper. Send me a photo of a prescription and I'll set up reminders.",
  },
  { id: 'seed2', from: 'user', text: 'Hello!' },
  {
    id: 'seed3', from: 'agent',
    text: 'Whenever you are ready, tap the 📷 button below to scan.',
  },
];

const state = {
  ready: false,
  tab: 'meds',           // initial tab, same as mobile
  userId: '',
  sessionId: '',
  backendUrl: '',        // '' = same origin (served from app.py)
  meds: [],
  messages: [],
  sending: false,
  pendingImage: null,    // { file: File, url: string }
  activeAlarm: null,     // { id, name, dose, instructions }
  // Per-card UI state, keyed by med.id (alarms/taken/etc. are NOT persisted,
  // same as mobile where they live in component state).
  cards: {},             // id → {taken, alarms:[{key,time,notifId}], picker, editing, scanning, scanResult, draft*}
};

function cardState(id) {
  if (!state.cards[id]) {
    state.cards[id] = {
      taken: false, alarms: [], picker: null, editing: false,
      scanning: false, scanResult: null, editTimePicker: false, drafts: null,
    };
  }
  return state.cards[id];
}

// ─────────────────────────────────────────────────────────────
// Time helpers (ported verbatim from App.tsx)
// ─────────────────────────────────────────────────────────────
function parseTime(str) {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i.exec(str.trim());
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = parseInt(m[2], 10);
  const ampm = m[3]?.toUpperCase();
  if (ampm === 'PM' && hour !== 12) hour += 12;
  if (ampm === 'AM' && hour === 12) hour = 0;
  return { hour, minute };
}
function formatTime(date) {
  let h = date.getHours();
  const m = date.getMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m.toString().padStart(2, '0')} ${ampm}`;
}
function timeStrToDate(str) {
  const t = parseTime(str) ?? { hour: 8, minute: 0 };
  const d = new Date();
  d.setHours(t.hour, t.minute, 0, 0);
  return d;
}

// ─────────────────────────────────────────────────────────────
// Modal dialogs (replaces Alert.alert; supports destructive/cancel)
// ─────────────────────────────────────────────────────────────
function showModal(title, message, buttons) {
  const backdrop = document.getElementById('modalBackdrop');
  document.getElementById('modalTitle').textContent = title;
  const msgEl = document.getElementById('modalMessage');
  msgEl.textContent = message || '';
  msgEl.hidden = !message;
  const box = document.getElementById('modalButtons');
  box.innerHTML = '';
  for (const b of buttons) {
    const btn = document.createElement('button');
    btn.className = 'modal-btn' + (b.style ? ` ${b.style}` : '');
    btn.textContent = b.text;
    btn.onclick = () => {
      backdrop.hidden = true;
      b.onPress?.();
    };
    box.appendChild(btn);
  }
  backdrop.hidden = false;
}
const alertModal = (title, message) => showModal(title, message, [{ text: 'OK' }]);

// ─────────────────────────────────────────────────────────────
// Image picking ("camera" = capture input, gallery = plain input)
// ─────────────────────────────────────────────────────────────
function pickImageFromCameraOrGallery({ title, message }) {
  return new Promise((resolve) => {
    const pick = (inputId) => {
      const input = document.getElementById(inputId);
      input.value = '';
      input.onchange = () => {
        const file = input.files && input.files[0];
        resolve(file ? { file, url: URL.createObjectURL(file) } : null);
      };
      input.click();
    };
    showModal(title, message, [
      { text: '📷 Take Photo', onPress: () => pick('filePickCamera') },
      { text: '🖼️ Choose from Gallery', onPress: () => pick('filePickGallery') },
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(null) },
    ]);
  });
}

// ─────────────────────────────────────────────────────────────
// Backend (exact same contract as mobile sendToAgent)
// ─────────────────────────────────────────────────────────────
function backendBase() {
  return (state.backendUrl || '').replace(/\/+$/, '');
}

async function sendToAgent(text, ids, image) {
  const form = new FormData();
  form.append('message', text);
  form.append('stream', 'false');
  if (ids?.userId) form.append('user_id', ids.userId);
  if (ids?.sessionId) form.append('session_id', ids.sessionId);
  if (image) form.append('files', image.file, 'prescription.jpg');

  const res = await fetch(`${backendBase()}/agents/${AGENT_ID}/runs`, {
    method: 'POST',
    headers: { 'ngrok-skip-browser-warning': 'true' },
    body: form,
  });
  if (!res.ok) throw new Error(`Server responded ${res.status}`);
  const data = await res.json();
  const reply = typeof data.content === 'string' ? data.content : JSON.stringify(data);
  return { reply, cards: extractCards(data) };
}

function extractCards(data) {
  const tools = Array.isArray(data.tools) ? data.tools : [];
  for (const t of tools) {
    const name = t.tool_name ?? t.name;
    if (name !== 'create_medication_cards') continue;
    let payload = t.result ?? t.content;
    if (typeof payload === 'string') {
      try { payload = JSON.parse(payload); } catch { payload = null; }
    }
    let cards = payload?.cards;
    if (!Array.isArray(cards)) {
      let args = t.tool_args ?? t.args;
      if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch { args = null; }
      }
      cards = args?.cards;
    }
    if (Array.isArray(cards) && cards.length > 0) {
      return cards.map((c) => ({ id: c.id ?? makeId(), ...c }));
    }
  }
  return null;
}

// Same verification prompt as mobile analyzeMedicationPhoto (incl. safety line 5).
async function analyzeMedicationPhoto(expected, image) {
  const prompt = [
    'You are helping verify a medicine from a caregiver app.',
    `Expected medicine name: ${expected.name}`,
    `Expected dose: ${expected.dose || 'Unknown'}`,
    `Expected schedule: ${expected.times.join(', ') || 'Not set'}`,
    `Expected instructions: ${expected.instructions || 'None'}`,
    'Analyze the attached photo and answer in concise markdown with:',
    '1) Match: Yes / No / Unsure',
    '2) What medicine this most likely is',
    '3) When it should be taken',
    '4) Any safety warning if uncertain',
    '5) Safety: check her stored records for allergies or medicines that could interact with this one',
  ].join('\n');
  const { reply } = await sendToAgent(
    prompt, { userId: state.userId, sessionId: state.sessionId }, image
  );
  return reply;
}

// ─────────────────────────────────────────────────────────────
// Alarms → Notification API + timers + speechSynthesis
// ─────────────────────────────────────────────────────────────
const alarmTimers = {}; // notifId → {timeout, med, daily, when}
let alarmSeq = 0;

async function setupAlarms() {
  if (!('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'default') await Notification.requestPermission();
  return Notification.permission;
}

function speak(line, rate = 1) {
  try {
    const u = new SpeechSynthesisUtterance(line);
    u.rate = rate;
    speechSynthesis.speak(u);
  } catch { /* no TTS available */ }
}

function fireAlarm(med) {
  // Browser notification (the downgraded "call")…
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      const n = new Notification('📞 Medicine reminder', {
        body: `Time to take ${med.name} (${med.dose})`,
        icon: 'favicon.png',
        tag: `alarm-${med.id}`,
      });
      n.onclick = () => { window.focus(); openAlarmScreen(med); n.close(); };
    } catch { /* ignore */ }
  }
  // …plus the in-page alarm screen, which "answers" immediately if the tab is open.
  openAlarmScreen(med);
}

function ringNow(med) {
  setupAlarms();
  fireAlarm(med);
  return 'ok';
}

function scheduleTestCall(med, seconds = 10) {
  const notifId = `t${++alarmSeq}`;
  alarmTimers[notifId] = {
    med, daily: false,
    timeout: setTimeout(() => { delete alarmTimers[notifId]; fireAlarm(med); }, seconds * 1000),
  };
  return notifId;
}

function scheduleDailyCall(med, when) {
  const notifId = `d${++alarmSeq}`;
  const schedule = () => {
    const next = new Date(when);
    next.setFullYear(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());
    if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
    const entry = alarmTimers[notifId];
    if (!entry) return;
    entry.timeout = setTimeout(() => {
      fireAlarm(med);
      schedule(); // re-arm for tomorrow
    }, next.getTime() - Date.now());
  };
  alarmTimers[notifId] = { med, daily: true, when, timeout: null };
  schedule();
  return notifId;
}

function cancelAlarm(notifId) {
  const entry = alarmTimers[notifId];
  if (entry) {
    clearTimeout(entry.timeout);
    delete alarmTimers[notifId];
  }
}

function openAlarmScreen(med) {
  state.activeAlarm = med;
  document.getElementById('alarmMedName').textContent = med.name;
  document.getElementById('alarmMedDose').textContent = med.dose;
  document.getElementById('alarmMedInstr').textContent = med.instructions;
  document.getElementById('alarmScreen').hidden = false;
  speak(
    `Hello. It is time to take your ${med.name}. Please take ${med.dose} now. ${med.instructions}.`,
    0.9
  );
}
function closeAlarmScreen() {
  state.activeAlarm = null;
  document.getElementById('alarmScreen').hidden = true;
  try { speechSynthesis.cancel(); } catch { /* ignore */ }
}

// ─────────────────────────────────────────────────────────────
// Rendering — meds
// ─────────────────────────────────────────────────────────────
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function mdToNode(markdown, cssClass) {
  const div = el('div', cssClass);
  div.innerHTML = marked.parse(markdown ?? '');
  // Neutralize any scripted content the model might emit.
  div.querySelectorAll('script,iframe,object,embed').forEach((n) => n.remove());
  div.querySelectorAll('a').forEach((a) => { a.target = '_blank'; a.rel = 'noopener'; });
  return div;
}

function renderMeds() {
  const list = document.getElementById('medsList');
  list.innerHTML = '';
  document.getElementById('manageHint').hidden = state.meds.length === 0;

  if (state.meds.length === 0) {
    list.appendChild(el('div', 'empty-meds',
      'No medicines yet. Go to 💬 Chat and scan a prescription to add some.'));
    return;
  }
  for (const med of state.meds) list.appendChild(renderCard(med));
}

function renderCard(med) {
  const cs = cardState(med.id);
  const card = el('div', 'card' + (cs.taken ? ' card-taken' : ''));

  // Long-press (400ms hold) or right-click → manage dialog (same as mobile).
  attachLongPress(card, () => handleManage(med), 400);

  if (cs.editing) {
    card.appendChild(renderEditBox(med, cs));
    return card;
  }

  // Top row: emoji + name + dose
  const top = el('div', 'card-top');
  top.appendChild(el('div', 'emoji', med.emoji));
  const topText = el('div', 'card-top-text');
  topText.appendChild(el('div', 'name', med.name));
  topText.appendChild(el('div', 'dose', med.dose));
  top.appendChild(topText);
  card.appendChild(top);

  // Time badges
  const times = el('div', 'times-row');
  for (const t of med.times) {
    const badge = el('div', 'time-badge');
    badge.appendChild(el('span', 'time-text', `🕐 ${t}`));
    times.appendChild(badge);
  }
  card.appendChild(times);

  if (med.instructions) card.appendChild(el('div', 'instructions', med.instructions));

  // Alarm rows
  for (const a of cs.alarms) {
    const row = el('div', 'alarm-row');
    row.appendChild(el('span', 'alarm-on', `🔔 Daily at ${formatTime(a.time)}`));
    const actions = el('div', 'alarm-actions');
    const change = el('button', 'alarm-link', 'Change');
    change.onclick = () => { cs.picker = { mode: 'change', key: a.key }; renderMeds(); };
    const remove = el('button', 'alarm-link alarm-off-link', 'Remove');
    remove.onclick = () => { cancelAlarm(a.notifId); cs.alarms = cs.alarms.filter((x) => x.key !== a.key); renderMeds(); };
    actions.appendChild(change);
    actions.appendChild(remove);
    row.appendChild(actions);
    card.appendChild(row);
  }

  // Set/add alarm button
  const setBtn = el('button', 'alarm-set-button',
    cs.alarms.length === 0
      ? `🔔 Set reminder (default ${med.times[0] ?? '8:00 AM'})`
      : '➕ Add another reminder');
  setBtn.onclick = async () => {
    await setupAlarms();
    cs.picker = { mode: 'add' };
    renderMeds();
  };
  card.appendChild(setBtn);

  // Test link
  const test = el('button', 'test-link', '▶ Test this alarm');
  test.onclick = () => handleTest(med);
  card.appendChild(test);

  // Scan button
  const scan = el('button', 'scan-button');
  if (cs.scanning) {
    scan.appendChild(el('span', 'spinner spinner-sm white'));
    scan.appendChild(document.createTextNode(' Scanning…'));
    scan.disabled = true;
  } else {
    scan.textContent = '📷 Scan this medicine';
  }
  scan.onclick = () => handleScanMedicine(med, cs);
  card.appendChild(scan);

  // Scan result box
  if (cs.scanResult) {
    const box = el('div', 'scan-result-box');
    box.appendChild(mdToNode(cs.scanResult, 'md-scan'));
    card.appendChild(box);
  }

  // Time picker (add/change)
  if (cs.picker) {
    card.appendChild(renderTimePicker(med, cs));
  }

  // Mark as taken
  const takenBtn = el('button', 'button' + (cs.taken ? ' button-taken' : ''),
    cs.taken ? '✓ Taken' : 'Mark as taken');
  takenBtn.onclick = () => { cs.taken = !cs.taken; renderMeds(); };
  card.appendChild(takenBtn);

  return card;
}

function defaultAddTime(med, cs) {
  const used = new Set(cs.alarms.map((a) => formatTime(a.time)));
  const free = med.times.find((t) => !used.has(t));
  return timeStrToDate(free ?? med.times[0] ?? '8:00 AM');
}

function renderTimePicker(med, cs) {
  const row = el('div', 'time-picker-row');
  const input = document.createElement('input');
  input.type = 'time';
  const initial = cs.picker.mode === 'change'
    ? cs.alarms.find((a) => a.key === cs.picker.key)?.time ?? defaultAddTime(med, cs)
    : defaultAddTime(med, cs);
  input.value = `${initial.getHours().toString().padStart(2, '0')}:${initial.getMinutes().toString().padStart(2, '0')}`;
  const ok = el('button', 'edit-save', 'Set');
  ok.style.flex = '0 0 auto';
  ok.style.padding = '10px 18px';
  ok.onclick = () => {
    const [h, m] = input.value.split(':').map(Number);
    const when = new Date();
    when.setHours(h, m, 0, 0);
    if (cs.picker.mode === 'add') {
      const notifId = scheduleDailyCall(toAlarmMed(med), when);
      cs.alarms.push({ key: newId('al'), time: when, notifId });
    } else {
      const entry = cs.alarms.find((a) => a.key === cs.picker.key);
      if (entry) {
        cancelAlarm(entry.notifId);
        entry.time = when;
        entry.notifId = scheduleDailyCall(toAlarmMed(med), when);
      }
    }
    cs.picker = null;
    renderMeds();
  };
  const cancel = el('button', 'edit-cancel', 'Cancel');
  cancel.style.flex = '0 0 auto';
  cancel.style.padding = '10px 18px';
  cancel.onclick = () => { cs.picker = null; renderMeds(); };
  row.appendChild(input);
  row.appendChild(ok);
  row.appendChild(cancel);
  return row;
}

function toAlarmMed(med) {
  return { id: med.id, name: med.name, dose: med.dose, instructions: med.instructions };
}

function handleTest(med) {
  showModal('Test reminder', 'When should the call come?', [
    { text: '🔔 Ring now', onPress: () => ringNow(toAlarmMed(med)) },
    {
      text: '⏱️ In 10 seconds',
      onPress: () => {
        scheduleTestCall(toAlarmMed(med), 10);
        alertModal('Reminder set',
          '📞 The call will come in 10 seconds — you can lock or leave the phone now.');
      },
    },
    { text: 'Cancel', style: 'cancel' },
  ]);
}

async function handleScanMedicine(med, cs) {
  if (cs.scanning) return;
  const image = await pickImageFromCameraOrGallery({
    title: 'Scan medicine',
    message: 'Where should the photo come from?',
  });
  if (!image) return;
  cs.scanning = true;
  renderMeds();
  try {
    const reply = await analyzeMedicationPhoto(med, image);
    cs.scanResult = reply;
    alertModal('Scan complete', 'AI analysis was added under this medicine card.');
  } catch (e) {
    alertModal('Scan failed', String(e));
  } finally {
    cs.scanning = false;
    URL.revokeObjectURL(image.url);
    renderMeds();
  }
}

function handleManage(med) {
  showModal(med.name, 'What would you like to do?', [
    { text: '✏️ Edit details', onPress: () => startEdit(med) },
    { text: '🗑️ Delete', style: 'destructive', onPress: () => confirmDelete(med) },
    { text: 'Cancel', style: 'cancel' },
  ]);
}

function startEdit(med) {
  const cs = cardState(med.id);
  cs.editing = true;
  cs.drafts = {
    name: med.name, dose: med.dose, instr: med.instructions, emoji: med.emoji,
    time: timeStrToDate(med.times[0] ?? '8:00 AM'),
  };
  renderMeds();
}

function confirmDelete(med) {
  showModal('Delete medicine', `Remove ${med.name} and its reminders?`, [
    {
      text: 'Delete', style: 'destructive',
      onPress: () => {
        const cs = cardState(med.id);
        for (const a of cs.alarms) cancelAlarm(a.notifId);
        delete state.cards[med.id];
        state.meds = state.meds.filter((m) => m.id !== med.id);
        persistMeds();
        renderMeds();
      },
    },
    { text: 'Cancel', style: 'cancel' },
  ]);
}

function renderEditBox(med, cs) {
  const d = cs.drafts;
  const box = el('div', 'edit-box');

  const topRow = el('div', 'edit-top-row');
  const emojiCol = el('div', 'edit-emoji-col');
  emojiCol.appendChild(el('div', 'edit-label', 'Icon'));
  const emojiInput = document.createElement('input');
  emojiInput.className = 'edit-emoji-input';
  emojiInput.maxLength = 4;
  emojiInput.placeholder = '💊';
  emojiInput.value = d.emoji;
  emojiInput.oninput = () => { d.emoji = emojiInput.value; };
  emojiCol.appendChild(emojiInput);
  const nameCol = el('div', 'edit-name-col');
  nameCol.appendChild(el('div', 'edit-label', 'Name'));
  const nameInput = document.createElement('input');
  nameInput.className = 'edit-input';
  nameInput.value = d.name;
  nameInput.oninput = () => { d.name = nameInput.value; };
  nameCol.appendChild(nameInput);
  topRow.appendChild(emojiCol);
  topRow.appendChild(nameCol);
  box.appendChild(topRow);

  box.appendChild(el('div', 'edit-label', 'Dose'));
  const doseInput = document.createElement('input');
  doseInput.className = 'edit-input';
  doseInput.value = d.dose;
  doseInput.oninput = () => { d.dose = doseInput.value; };
  box.appendChild(doseInput);

  box.appendChild(el('div', 'edit-label', 'Default time'));
  if (cs.editTimePicker) {
    const row = el('div', 'time-picker-row');
    const t = document.createElement('input');
    t.type = 'time';
    t.value = `${d.time.getHours().toString().padStart(2, '0')}:${d.time.getMinutes().toString().padStart(2, '0')}`;
    const ok = el('button', 'edit-save', 'Set');
    ok.style.flex = '0 0 auto';
    ok.style.padding = '10px 18px';
    ok.onclick = () => {
      const [h, m] = t.value.split(':').map(Number);
      d.time = new Date();
      d.time.setHours(h, m, 0, 0);
      cs.editTimePicker = false;
      renderMeds();
    };
    row.appendChild(t);
    row.appendChild(ok);
    box.appendChild(row);
  } else {
    const timeBtn = el('button', 'edit-time-button', `🕐 ${formatTime(d.time)}`);
    timeBtn.onclick = () => { cs.editTimePicker = true; renderMeds(); };
    box.appendChild(timeBtn);
  }

  box.appendChild(el('div', 'edit-label', 'Instructions'));
  const instrInput = document.createElement('textarea');
  instrInput.className = 'edit-input edit-input-multiline';
  instrInput.value = d.instr;
  instrInput.oninput = () => { d.instr = instrInput.value; };
  box.appendChild(instrInput);

  const actions = el('div', 'edit-actions');
  const cancel = el('button', 'edit-cancel', 'Cancel');
  cancel.onclick = () => { cs.editing = false; cs.drafts = null; renderMeds(); };
  const save = el('button', 'edit-save', 'Save');
  save.onclick = () => {
    const updated = {
      ...med,
      name: d.name.trim() || med.name,
      dose: d.dose.trim() || med.dose,
      instructions: d.instr.trim(),
      emoji: d.emoji.trim() || med.emoji,
      times: [formatTime(d.time), ...med.times.slice(1)],
    };
    state.meds = state.meds.map((m) => (m.id === med.id ? updated : m));
    cs.editing = false;
    cs.drafts = null;
    persistMeds();
    renderMeds();
  };
  actions.appendChild(cancel);
  actions.appendChild(save);
  box.appendChild(actions);

  return box;
}

// Long-press helper: touch/mouse hold + contextmenu.
function attachLongPress(node, handler, ms) {
  let timer = null;
  const start = () => { timer = setTimeout(handler, ms); };
  const stop = () => { if (timer) { clearTimeout(timer); timer = null; } };
  node.addEventListener('mousedown', (e) => { if (e.button === 0) start(); });
  node.addEventListener('touchstart', start, { passive: true });
  for (const ev of ['mouseup', 'mouseleave', 'touchend', 'touchmove', 'touchcancel']) {
    node.addEventListener(ev, stop);
  }
  node.addEventListener('contextmenu', (e) => { e.preventDefault(); stop(); handler(); });
}

// ─────────────────────────────────────────────────────────────
// Rendering — chat
// ─────────────────────────────────────────────────────────────
function renderChat() {
  const list = document.getElementById('chatList');
  list.innerHTML = '';
  for (const msg of state.messages) {
    const bubble = el('div', `bubble bubble-${msg.from}`);
    if (msg.imageUri) {
      const img = document.createElement('img');
      img.className = 'bubble-image';
      img.src = msg.imageUri;
      img.alt = '';
      bubble.appendChild(img);
    }
    if (msg.from === 'agent') {
      if (msg.text) bubble.appendChild(mdToNode(msg.text, 'md'));
    } else if (msg.text) {
      bubble.appendChild(el('div', 'bubble-text bubble-text-user', msg.text));
    }
    list.appendChild(bubble);
  }
  if (state.sending) {
    const typing = el('div', 'bubble bubble-agent typing-bubble');
    typing.appendChild(el('span', 'spinner spinner-sm grey'));
    typing.appendChild(el('span', 'typing-text', 'typing…'));
    list.appendChild(typing);
  }
  list.scrollTop = list.scrollHeight;
  renderInputBar();
}

function renderInputBar() {
  const row = document.getElementById('pendingImageRow');
  row.hidden = !state.pendingImage;
  if (state.pendingImage) {
    document.getElementById('pendingImagePreview').src = state.pendingImage.url;
  }
  document.getElementById('chatInput').disabled = state.sending;
  document.getElementById('attachBtn').disabled = state.sending;
  document.getElementById('newChatBtn').disabled = state.sending;
  const sendBtn = document.getElementById('sendBtn');
  sendBtn.disabled = state.sending;
  document.getElementById('sendBtnLabel').innerHTML =
    state.sending ? '<span class="spinner spinner-sm white"></span>' : '➤';
}

function persistMeds() { if (state.ready) saveJSON(STORE.meds, state.meds); }
function persistChat() { if (state.ready) saveJSON(STORE.chat, state.messages); }

function addCards(cards) {
  // Merge by lowercase name: same name replaces, new names append (as mobile).
  const byName = new Map(state.meds.map((m) => [m.name.toLowerCase(), m]));
  for (const c of cards) byName.set(c.name.toLowerCase(), c);
  state.meds = [...byName.values()];
  persistMeds();
  renderMeds();
  switchTab('meds'); // auto-jump to the Meds tab, same as mobile
}

async function handleSend() {
  if (state.sending) return;
  const inputEl = document.getElementById('chatInput');
  const shownText = inputEl.value.trim();
  const image = state.pendingImage;
  if (!shownText && !image) return;

  const backendText = shownText || 'Please read this attached image.';
  state.messages.push({
    id: newId('m'), from: 'user', text: shownText, imageUri: image?.url,
  });
  inputEl.value = '';
  state.pendingImage = null;
  state.sending = true;
  persistChat();
  renderChat();

  try {
    const { reply, cards } = await sendToAgent(
      backendText, { userId: state.userId, sessionId: state.sessionId }, image
    );
    state.messages.push({ id: newId('m'), from: 'agent', text: reply });
    if (cards) addCards(cards);
  } catch (err) {
    state.messages.push({
      id: newId('m'), from: 'agent',
      text: '⚠️ Could not reach the agent.\n' + String(err),
    });
  } finally {
    state.sending = false;
    persistChat();
    renderChat();
  }
}

async function handlePickImage() {
  const image = await pickImageFromCameraOrGallery({
    title: 'Add a prescription',
    message: 'Where should the photo come from?',
  });
  if (image) {
    state.pendingImage = image;
    renderInputBar();
  }
}

function startFreshSession() {
  state.sessionId = newId('session');
  saveJSON(STORE.sessionId, state.sessionId);
  state.messages = [...SEED_MESSAGES];
  persistChat();
  renderChat();
}

function handleNewSession() {
  if (state.sending) return;
  showModal(
    'Start a new conversation?',
    'This clears the chat on this phone and begins a fresh session. Your medicines are kept.',
    [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Start fresh', style: 'destructive', onPress: startFreshSession },
    ]
  );
}

// ─────────────────────────────────────────────────────────────
// Tabs + settings
// ─────────────────────────────────────────────────────────────
function switchTab(tab) {
  state.tab = tab;
  document.getElementById('medsScreen').hidden = tab !== 'meds';
  document.getElementById('chatScreen').hidden = tab !== 'chat';
  document.querySelector('#tabMeds .tab-label').classList.toggle('active', tab === 'meds');
  document.querySelector('#tabChat .tab-label').classList.toggle('active', tab === 'chat');
}

function openSettings() {
  document.getElementById('settingsUser').value = state.userId;
  document.getElementById('settingsSession').value = state.sessionId;
  document.getElementById('settingsBackend').value = state.backendUrl;
  document.getElementById('settingsScreen').hidden = false;
}

function saveSettings() {
  const u = document.getElementById('settingsUser').value.trim() || state.userId;
  const s = document.getElementById('settingsSession').value.trim() || state.sessionId;
  const b = document.getElementById('settingsBackend').value.trim();
  state.userId = u;
  state.sessionId = s;
  state.backendUrl = b;
  saveJSON(STORE.userId, u);
  saveJSON(STORE.sessionId, s);
  saveJSON(STORE.backendUrl, b);
  document.getElementById('settingsScreen').hidden = true;
}

// ─────────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────────
function boot() {
  // Load persisted state (mint ids on first run, like mobile).
  let uid = loadJSON(STORE.userId, '');
  let sid = loadJSON(STORE.sessionId, '');
  if (!uid) { uid = newId('user'); saveJSON(STORE.userId, uid); }
  if (!sid) { sid = newId('session'); saveJSON(STORE.sessionId, sid); }
  state.userId = uid;
  state.sessionId = sid;
  state.backendUrl = loadJSON(STORE.backendUrl, '');
  state.meds = loadJSON(STORE.meds, []);
  state.messages = loadJSON(STORE.chat, [...SEED_MESSAGES]);
  state.ready = true;

  // Wire events.
  document.getElementById('tabMeds').onclick = () => switchTab('meds');
  const tabChat = document.getElementById('tabChat');
  tabChat.onclick = () => switchTab('chat');
  attachLongPress(tabChat, openSettings, 600); // hidden caregiver settings

  document.getElementById('newChatBtn').onclick = handleNewSession;
  document.getElementById('sendBtn').onclick = handleSend;
  document.getElementById('attachBtn').onclick = handlePickImage;
  document.getElementById('pendingImageRemove').onclick = () => {
    state.pendingImage = null;
    renderInputBar();
  };
  const input = document.getElementById('chatInput');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  });

  document.getElementById('settingsSave').onclick = saveSettings;
  document.getElementById('settingsClose').onclick = () => {
    document.getElementById('settingsScreen').hidden = true;
  };
  document.getElementById('settingsNew').onclick = () => {
    startFreshSession();
    document.getElementById('settingsScreen').hidden = true;
  };

  document.getElementById('alarmDone').onclick = closeAlarmScreen;
  document.getElementById('alarmRepeat').onclick = () => {
    if (state.activeAlarm) speak(`Please take your ${state.activeAlarm.name} now.`);
  };

  // Show the UI.
  renderMeds();
  renderChat();
  switchTab('meds');
  document.getElementById('splash').hidden = true;
  document.getElementById('tabs').hidden = false;
}

boot();
