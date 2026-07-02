import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';

import { STORE, loadJSON, saveJSON, newId } from './storage';
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Markdown from 'react-native-markdown-display';
import * as ImagePicker from 'expo-image-picker';
import * as Speech from 'expo-speech';
import notifee, { EventType } from '@notifee/react-native';
import DateTimePicker, {
  DateTimePickerEvent,
} from '@react-native-community/datetimepicker';
import {
  AlarmMed,
  ANSWER_ACTION,
  DECLINE_ACTION,
  cancelAlarm,
  ringNow,
  scheduleDailyCall,
  scheduleTestCall,
  setupAlarms,
  stopRinging,
} from './alarm';

// ═══════════════════════════════════════════════════════════════
// BACKEND CONFIG
//   • AGENT_OS_URL comes from mobile/.env (EXPO_PUBLIC_AGENT_OS_URL).
//     On a PHYSICAL phone this MUST be your PC's LAN IP (find via
//     `ipconfig`), e.g. http://192.168.1.50:7777 — NOT localhost.
//     (The agent server moved to port 7777; ngrok must tunnel 7777 too.
//     Port 8000 now belongs to the cognee memory backend.)
//   • AGENT_ID must match Agent(id=...) in agents.py (we used "agent").
// The `?? '...'` is a fallback used only if the .env value is missing.
// ═══════════════════════════════════════════════════════════════
const AGENT_OS_URL = (
  process.env.EXPO_PUBLIC_AGENT_OS_URL ?? 'http://192.168.1.50:7777'
).replace(/\/+$/, ''); // strip any trailing slash so we don't get "//agents"
const AGENT_ID = 'agent';

// Tiny helper so every chat message gets a unique id.
function makeId(): string {
  return Math.random().toString(36).slice(2);
}

type ImageSource = 'camera' | 'gallery';

async function pickImageFromSource(
  source: ImageSource,
  quality: number,
  cameraPermissionMessage: string
): Promise<string | null> {
  let result: ImagePicker.ImagePickerResult;

  if (source === 'camera') {
    // Camera needs runtime permission; the gallery picker does not.
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Permission needed', cameraPermissionMessage);
      return null;
    }
    result = await ImagePicker.launchCameraAsync({ quality });
  } else {
    result = await ImagePicker.launchImageLibraryAsync({ quality });
  }

  if (result.canceled) return null;
  return result.assets[0]?.uri ?? null;
}

// Shared picker UI used by chat and card-level medicine scan.
function pickImageFromCameraOrGallery({
  title,
  message,
  quality,
  cameraPermissionMessage,
}: {
  title: string;
  message: string;
  quality: number;
  cameraPermissionMessage: string;
}): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const settle = (uri: string | null) => {
      if (done) return;
      done = true;
      resolve(uri);
    };

    const from = async (source: ImageSource) => {
      try {
        const uri = await pickImageFromSource(source, quality, cameraPermissionMessage);
        settle(uri);
      } catch {
        settle(null);
      }
    };

    Alert.alert(title, message, [
      { text: '📷 Take Photo', onPress: () => from('camera') },
      { text: '🖼️ Choose from Gallery', onPress: () => from('gallery') },
      { text: 'Cancel', style: 'cancel', onPress: () => settle(null) },
    ]);
  });
}

// ─────────────────────────────────────────────────────────────
// 1. THE DATA SHAPE
// Like a Pydantic model: it describes what one medication looks
// like. TypeScript will warn you if you build one wrong.
// ─────────────────────────────────────────────────────────────
type Medication = {
  id: string;
  name: string;          // "Metformin"
  dose: string;          // "500 mg — 1 tablet"
  times: string[];       // ["8:00 AM", "8:00 PM"]
  instructions: string;  // "Take after food"
  emoji: string;         // a big friendly icon
};

// ─────────────────────────────────────────────────────────────
// 2. FAKE DATA
// Hardcoded for now. In Phase 3 this comes from your FastAPI
// backend as JSON; the UI won't care where it came from.
// ─────────────────────────────────────────────────────────────
const SAMPLE_MEDS: Medication[] = [
  {
    id: '1',
    name: 'Metformin',
    dose: '500 mg — 1 tablet',
    times: ['8:00 AM', '8:00 PM'],
    instructions: 'Take after food',
    emoji: '💊',
  },
  {
    id: '2',
    name: 'Amlodipine',
    dose: '5 mg — 1 tablet',
    times: ['9:00 AM'],
    instructions: 'For blood pressure',
    emoji: '❤️',
  },
  {
    id: '3',
    name: 'Vitamin D',
    dose: '1 capsule',
    times: ['1:00 PM'],
    instructions: 'Take with lunch',
    emoji: '☀️',
  },
];

// ─────────────────────────────────────────────────────────────
// 2b. ALARM TIME HELPERS
// The scheduling itself lives in alarm.ts (Notifee, incoming-call
// style). These helpers just convert times for the picker + display.
// ─────────────────────────────────────────────────────────────

// "8:00 AM" → { hour: 8, minute: 0 }
function parseTime(timeStr: string): { hour: number; minute: number } {
  const m = timeStr.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if (!m) return { hour: 8, minute: 0 };
  let hour = parseInt(m[1], 10);
  const minute = parseInt(m[2], 10);
  const ampm = m[3]?.toUpperCase();
  if (ampm === 'PM' && hour !== 12) hour += 12;
  if (ampm === 'AM' && hour === 12) hour = 0;
  return { hour, minute };
}

// "8:00 AM" → a Date today at that time (the picker's DEFAULT value)
function timeStrToDate(timeStr: string): Date {
  const { hour, minute } = parseTime(timeStr);
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  return d;
}

// Date → "8:05 AM"
function formatTime(d: Date): string {
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${m.toString().padStart(2, '0')} ${ampm}`;
}

// Turn a full Medication into the slim data the alarm needs.
function toAlarmMed(med: Medication): AlarmMed {
  return {
    id: med.id,
    name: med.name,
    dose: med.dose,
    instructions: med.instructions,
  };
}

// Ask the backend agent to verify a medicine photo against a card.
async function analyzeMedicationPhoto(
  expected: Medication,
  imageUri: string,
  ids: { userId: string; sessionId: string }
): Promise<string> {
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

  // Send WITH the session ids: the safety check (item 5) makes the agent
  // recall her allergies/medicines from Cognee, and the exchange itself
  // gets captured into the session record.
  const { reply } = await sendToAgent(prompt, ids, imageUri);
  return reply;
}

// One scheduled reminder for a medicine. A medicine can have several.
//   key     = stable id for React + local lookups
//   time    = when it rings each day
//   notifId = Notifee's id, needed to cancel/reschedule it
type AlarmEntry = { key: string; time: Date; notifId: string };

// What the picker is currently being used for.
//   { mode: 'add' }          → create a new alarm
//   { mode: 'change', key }   → re-time an existing alarm
type PickerState = { mode: 'add' | 'change'; key?: string } | null;

// ─────────────────────────────────────────────────────────────
// 3. ONE CARD — multiple alarms, long-press to edit/delete
// ─────────────────────────────────────────────────────────────
function MedicationCard({
  med,
  onEdit,
  onDelete,
  ids,
}: {
  med: Medication;
  onEdit: (updated: Medication) => void;
  onDelete: (id: string) => void;
  ids: { userId: string; sessionId: string };
}) {
  const [taken, setTaken] = useState(false);
  const [alarms, setAlarms] = useState<AlarmEntry[]>([]);
  const [picker, setPicker] = useState<PickerState>(null);

  // Inline edit mode: when true, the details become editable.
  const [editing, setEditing] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<string | null>(null);
  const [draftName, setDraftName] = useState(med.name);
  const [draftDose, setDraftDose] = useState(med.dose);
  const [draftInstr, setDraftInstr] = useState(med.instructions);
  const [draftEmoji, setDraftEmoji] = useState(med.emoji);
  const [draftTime, setDraftTime] = useState<Date>(timeStrToDate(med.times[0] ?? '8:00 AM'));
  const [editTimePicker, setEditTimePicker] = useState(false);

  // ----- ALARMS -----

  // Default time for a NEW alarm: the first prescription time that doesn't
  // already have an alarm, else the first time, else 8:00 AM.
  function defaultAddTime(): Date {
    const used = new Set(alarms.map((a) => formatTime(a.time)));
    const free = med.times.find((t) => !used.has(t));
    return timeStrToDate(free ?? med.times[0] ?? '8:00 AM');
  }

  async function addAlarm(when: Date) {
    const id = await scheduleDailyCall(toAlarmMed(med), when);
    setAlarms((prev) => [...prev, { key: makeId(), time: when, notifId: id }]);
  }

  async function changeAlarm(key: string, when: Date) {
    const target = alarms.find((a) => a.key === key);
    if (target) await cancelAlarm(target.notifId); // drop the old schedule
    const id = await scheduleDailyCall(toAlarmMed(med), when);
    setAlarms((prev) =>
      prev.map((a) => (a.key === key ? { ...a, time: when, notifId: id } : a))
    );
  }

  async function removeAlarm(key: string) {
    const target = alarms.find((a) => a.key === key);
    if (target) await cancelAlarm(target.notifId);
    setAlarms((prev) => prev.filter((a) => a.key !== key));
  }

  // Android's picker is one-shot: it calls this once when dismissed.
  function onPickTime(event: DateTimePickerEvent, date?: Date) {
    const current = picker;
    setPicker(null);
    if (event.type !== 'set' || !date || !current) return;
    if (current.mode === 'add') addAlarm(date);
    else if (current.key) changeAlarm(current.key, date);
  }

  // ----- LONG-PRESS: manage this medicine (hidden from accidental taps) -----
  function handleManage() {
    Alert.alert(med.name, 'What would you like to do?', [
      { text: '✏️ Edit details', onPress: startEdit },
      { text: '🗑️ Delete', style: 'destructive', onPress: confirmDelete },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }

  function startEdit() {
    // load current values into the draft fields, then show the inputs
    setDraftName(med.name);
    setDraftDose(med.dose);
    setDraftInstr(med.instructions);
    setDraftEmoji(med.emoji);
    setDraftTime(timeStrToDate(med.times[0] ?? '8:00 AM'));
    setEditing(true);
  }

  function saveEdit() {
    // The default time becomes times[0]; any extra prescription times stay.
    const newTimes = [formatTime(draftTime), ...med.times.slice(1)];
    onEdit({
      ...med,
      name: draftName.trim() || med.name,
      dose: draftDose.trim(),
      instructions: draftInstr.trim(),
      emoji: draftEmoji.trim() || med.emoji,
      times: newTimes,
    });
    setEditing(false);
  }

  // Edit-mode time picker (separate from the alarm picker above).
  function onPickEditTime(event: DateTimePickerEvent, date?: Date) {
    setEditTimePicker(false);
    if (event.type === 'set' && date) setDraftTime(date);
  }

  function confirmDelete() {
    Alert.alert('Delete medicine', `Remove ${med.name} and its reminders?`, [
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          // cancel this card's alarms before the card disappears
          await Promise.all(alarms.map((a) => cancelAlarm(a.notifId)));
          onDelete(med.id);
        },
      },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }

  // ----- TEST (ring now / in 10s) -----
  function handleTest() {
    Alert.alert('Test reminder', 'When should the call come?', [
      { text: '🔔 Ring now', onPress: testNow },
      { text: '⏱️ In 10 seconds', onPress: testIn10 },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }

  async function testNow() {
    try {
      const result = await ringNow(toAlarmMed(med));
      if (result !== 'ok') Alert.alert('Reminder', result);
    } catch (e) {
      Alert.alert('Alarm error', String(e));
    }
  }

  async function testIn10() {
    try {
      await scheduleTestCall(toAlarmMed(med), 10);
      Alert.alert(
        'Reminder set',
        '📞 The call will come in 10 seconds — you can lock or leave the phone now.'
      );
    } catch (e) {
      Alert.alert('Alarm error', String(e));
    }
  }

  // Capture a medicine photo and ask the backend agent to verify it.
  async function handleScanMedicine() {
    if (scanning) return;

    try {
      const uri = await pickImageFromCameraOrGallery({
        title: 'Scan medicine',
        message: 'Where should the photo come from?',
        quality: 0.7,
        cameraPermissionMessage: 'Camera access is required to scan medicine.',
      });
      if (!uri) return;

      setScanning(true);
      const reply = await analyzeMedicationPhoto(med, uri, ids);
      setScanResult(reply);
      Alert.alert('Scan complete', 'AI analysis was added under this medicine card.');
    } catch (e) {
      Alert.alert('Scan failed', String(e));
    } finally {
      setScanning(false);
    }
  }

  // The card root is a Pressable so a LONG-press (anywhere that isn't a
  // button) opens the manage menu. A normal tap does nothing — that keeps
  // edit/delete out of grandma's way.
  return (
    <Pressable
      onLongPress={handleManage}
      delayLongPress={400}
      style={[styles.card, taken && styles.cardTaken]}
    >
      {editing ? (
        // ---- INLINE EDIT: icon / name / dose / time / instructions ----
        <View style={styles.editBox}>
          <View style={styles.editTopRow}>
            <View style={styles.editEmojiCol}>
              <Text style={styles.editLabel}>Icon</Text>
              <TextInput
                style={styles.editEmojiInput}
                value={draftEmoji}
                onChangeText={setDraftEmoji}
                maxLength={4}
                placeholder="💊"
              />
            </View>
            <View style={styles.editNameCol}>
              <Text style={styles.editLabel}>Name</Text>
              <TextInput
                style={styles.editInput}
                value={draftName}
                onChangeText={setDraftName}
              />
            </View>
          </View>

          <Text style={styles.editLabel}>Dose</Text>
          <TextInput style={styles.editInput} value={draftDose} onChangeText={setDraftDose} />

          <Text style={styles.editLabel}>Default time</Text>
          <Pressable style={styles.editTimeButton} onPress={() => setEditTimePicker(true)}>
            <Text style={styles.editTimeText}>🕐 {formatTime(draftTime)}</Text>
          </Pressable>

          <Text style={styles.editLabel}>Instructions</Text>
          <TextInput
            style={[styles.editInput, styles.editInputMultiline]}
            value={draftInstr}
            onChangeText={setDraftInstr}
            multiline
          />

          {editTimePicker && (
            <DateTimePicker
              value={draftTime}
              mode="time"
              display="default"
              onChange={onPickEditTime}
            />
          )}

          <View style={styles.editActions}>
            <Pressable style={styles.editCancel} onPress={() => setEditing(false)}>
              <Text style={styles.editCancelText}>Cancel</Text>
            </Pressable>
            <Pressable style={styles.editSave} onPress={saveEdit}>
              <Text style={styles.editSaveText}>Save</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        // ---- NORMAL VIEW ----
        <>
          <View style={styles.cardTop}>
            <Text style={styles.emoji}>{med.emoji}</Text>
            <View style={styles.cardTopText}>
              <Text style={styles.name}>{med.name}</Text>
              <Text style={styles.dose}>{med.dose}</Text>
            </View>
          </View>

          <View style={styles.timesRow}>
            {med.times.map((time) => (
              <View key={time} style={styles.timeBadge}>
                <Text style={styles.timeText}>🕐 {time}</Text>
              </View>
            ))}
          </View>

          {!!med.instructions && (
            <Text style={styles.instructions}>{med.instructions}</Text>
          )}

          {/* ALARMS — one row per reminder, plus an Add button */}
          {alarms.map((a) => (
            <View key={a.key} style={styles.alarmRow}>
              <Text style={styles.alarmOn}>🔔 Daily at {formatTime(a.time)}</Text>
              <View style={styles.alarmActions}>
                <Pressable onPress={() => setPicker({ mode: 'change', key: a.key })}>
                  <Text style={styles.alarmLink}>Change</Text>
                </Pressable>
                <Pressable onPress={() => removeAlarm(a.key)}>
                  <Text style={[styles.alarmLink, styles.alarmOffLink]}>Remove</Text>
                </Pressable>
              </View>
            </View>
          ))}

          <Pressable style={styles.alarmSetButton} onPress={() => setPicker({ mode: 'add' })}>
            <Text style={styles.alarmSetText}>
              {alarms.length === 0
                ? `🔔 Set reminder (default ${med.times[0] ?? '8:00 AM'})`
                : '➕ Add another reminder'}
            </Text>
          </Pressable>

          {/* choose: ring now, or schedule a call in 10s */}
          <Pressable onPress={handleTest}>
            <Text style={styles.testLink}>▶ Test this alarm</Text>
          </Pressable>

          <Pressable
            style={[styles.scanButton, scanning && styles.scanButtonDisabled]}
            onPress={handleScanMedicine}
            disabled={scanning}
          >
            {scanning ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={styles.scanButtonText}>📷 Scan this medicine</Text>
            )}
          </Pressable>

          {!!scanResult && (
            <View style={styles.scanResultBox}>
              <Markdown style={scanMarkdownStyles}>{scanResult}</Markdown>
            </View>
          )}

          {picker && (
            <DateTimePicker
              value={
                picker.mode === 'change'
                  ? alarms.find((a) => a.key === picker.key)?.time ?? defaultAddTime()
                  : defaultAddTime()
              }
              mode="time"
              display="default"
              onChange={onPickTime}
            />
          )}

          <Pressable
            style={[styles.button, taken && styles.buttonTaken]}
            onPress={() => setTaken(!taken)}
          >
            <Text style={styles.buttonText}>{taken ? '✓ Taken' : 'Mark as taken'}</Text>
          </Pressable>
        </>
      )}
    </Pressable>
  );
}

// ─────────────────────────────────────────────────────────────
// 4. THE MEDS SCREEN (your Phase 1 cards, just moved into their
// own component so it can live behind the 💊 Meds tab)
// ─────────────────────────────────────────────────────────────
function MedicinesScreen({
  meds,
  onEdit,
  onDelete,
  ids,
}: {
  meds: Medication[];
  onEdit: (updated: Medication) => void;
  onDelete: (id: string) => void;
  ids: { userId: string; sessionId: string };
}) {
  return (
    <View style={styles.screen}>
      <Text style={styles.header}>Today's Medicines</Text>
      <ScrollView contentContainerStyle={styles.list}>
        {meds.length === 0 ? (
          <Text style={styles.emptyMeds}>
            No medicines yet. Go to 💬 Chat and scan a prescription to add some.
          </Text>
        ) : (
          meds.map((med) => (
            <MedicationCard key={med.id} med={med} onEdit={onEdit} onDelete={onDelete} ids={ids} />
          ))
        )}
      </ScrollView>
      {meds.length > 0 && (
        <Text style={styles.manageHint}>Press and hold a medicine to edit or delete it.</Text>
      )}
    </View>
  );
}

// ─────────────────────────────────────────────────────────────
// 5a. THE CHAT MESSAGE SHAPE (another little data model)
// 'from' tells us who sent it, which decides left vs right.
// ─────────────────────────────────────────────────────────────
type ChatMessage = {
  id: string;
  from: 'user' | 'agent';
  text: string;
  imageUri?: string; // optional attached photo (file path on the phone)
};

// Fake conversation to start with, so we can see both bubble sides.
// In Step 4 these become real messages you type.
const SEED_MESSAGES: ChatMessage[] = [
  {
    id: '1',
    from: 'agent',
    text: "Hi! 👋 I'm your medicine helper. Send me a photo of a prescription and I'll set up reminders.",
  },
  { id: '2', from: 'user', text: 'Hello!' },
  {
    id: '3',
    from: 'agent',
    text: 'Whenever you are ready, tap the 📷 button below to scan.',
  },
];

// ─────────────────────────────────────────────────────────────
// 5b. ONE CHAT BUBBLE
// isUser flips everything: which side it sits on and its colors.
// ─────────────────────────────────────────────────────────────
// Markdown look for AGENT bubbles (the agent replies in markdown).
// The library's style typing is loose, so we type it as `any`.
const markdownStyles: any = {
  body: { fontSize: 18, lineHeight: 24, color: '#0F172A' },
  strong: { fontWeight: '700' },
  em: { fontStyle: 'italic' },
  heading1: { fontSize: 24, fontWeight: '800', marginVertical: 4 },
  heading2: { fontSize: 22, fontWeight: '800', marginVertical: 4 },
  heading3: { fontSize: 20, fontWeight: '700', marginVertical: 4 },
  bullet_list: { marginVertical: 4 },
  ordered_list: { marginVertical: 4 },
  list_item: { marginVertical: 2 },
  code_inline: {
    backgroundColor: '#E2E8F0',
    borderRadius: 4,
    paddingHorizontal: 4,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  fence: { backgroundColor: '#E2E8F0', borderRadius: 8, padding: 10 },
  link: { color: '#2563EB' },
};

const scanMarkdownStyles: any = {
  body: { fontSize: 16, lineHeight: 22, color: '#0F172A' },
  strong: { fontWeight: '700' },
  bullet_list: { marginVertical: 2 },
  ordered_list: { marginVertical: 2 },
  list_item: { marginVertical: 1 },
  paragraph: { marginVertical: 2 },
};

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.from === 'user';

  return (
    <View style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAgent]}>
      {/* if this message has a photo, show it on top */}
      {message.imageUri && (
        <Image source={{ uri: message.imageUri }} style={styles.bubbleImage} />
      )}
      {isUser ? (
        // your messages are plain text
        <Text style={[styles.bubbleText, styles.bubbleTextUser]}>{message.text}</Text>
      ) : (
        // the agent replies in markdown — render it richly
        <Markdown style={markdownStyles}>{message.text}</Markdown>
      )}
    </View>
  );
}

// ─────────────────────────────────────────────────────────────
// 5c. TALK TO THE BACKEND
// Sends one message to your AgentOS run endpoint and returns BOTH
// the agent's reply text AND any medication cards the agent built.
// Uses multipart/form-data (what the endpoint expects) and
// stream=false (one request → one JSON reply).
// ─────────────────────────────────────────────────────────────

// What one round-trip to the agent gives us back.
type AgentReply = {
  reply: string;              // the chat text to show in a bubble
  cards: Medication[] | null; // cards the agent created this turn, if any
};

// Dig the medication cards out of the run response. The backend tool
// `create_medication_cards` returns { type, cards } and Agno attaches
// that under `data.tools[]`. Serialization details vary, so we probe a
// few likely field names instead of trusting exactly one shape.
function extractCards(data: any): Medication[] | null {
  const tools = Array.isArray(data?.tools) ? data.tools : [];
  for (const t of tools) {
    const name = t?.tool_name ?? t?.name;
    if (name !== 'create_medication_cards') continue;

    // The tool's RETURN value (has the backend-generated ids).
    let payload: any = t?.result ?? t?.content;
    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload);
      } catch {
        payload = null;
      }
    }
    let cards = payload?.cards;

    // Fallback: if the result wasn't usable, use the ARGUMENTS the model
    // passed in. Those lack ids, so we mint one per card on the client.
    if (!Array.isArray(cards)) {
      let args: any = t?.tool_args ?? t?.args;
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args);
        } catch {
          args = null;
        }
      }
      cards = args?.cards;
    }

    if (Array.isArray(cards) && cards.length > 0) {
      // Make sure every card has an id (React list keys + alarm id).
      return cards.map((c: any) => ({ id: c.id ?? makeId(), ...c })) as Medication[];
    }
  }
  return null;
}

async function sendToAgent(
  message: string,
  ids?: { userId: string; sessionId: string },
  imageUri?: string
): Promise<AgentReply> {
  const form = new FormData();
  form.append('message', message);
  form.append('stream', 'false');
  // Tie this run to a stable user + conversation so the backend (now on
  // SQLite) can remember the history across restarts. Optional: a one-off
  // call (e.g. a photo check) can skip these and get a fresh thread.
  if (ids?.userId) form.append('user_id', ids.userId);
  if (ids?.sessionId) form.append('session_id', ids.sessionId);
  if (imageUri) {
    // attach the photo as a file part (what the endpoint's `files` field expects)
    form.append('files', {
      uri: imageUri,
      name: 'prescription.jpg',
      type: 'image/jpeg',
    } as any);
  }

  const res = await fetch(`${AGENT_OS_URL}/agents/${AGENT_ID}/runs`, {
    method: 'POST',
    body: form,
    // Skips ngrok's free-tier browser warning page (harmless otherwise).
    headers: { 'ngrok-skip-browser-warning': 'true' },
  });

  if (!res.ok) {
    throw new Error(`Server responded ${res.status}`);
  }

  const data = await res.json();
  // Agno puts the agent's reply text in `content`; cards ride along in `tools`.
  const reply =
    typeof data?.content === 'string' ? data.content : JSON.stringify(data);
  return { reply, cards: extractCards(data) };
}

// ─────────────────────────────────────────────────────────────
// 5d. THE CHAT SCREEN — bubbles + a real input bar wired to the
// agent. Type → your bubble appears instantly → agent replies.
// ─────────────────────────────────────────────────────────────
function ChatScreen({
  messages,
  setMessages,
  onCards,
  userId,
  sessionId,
  onNewSession,
}: {
  // Chat state is OWNED by App now (so it can be persisted). ChatScreen just
  // reads it and appends to it — hence messages + setMessages come as props.
  messages: ChatMessage[];
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  onCards: (cards: Medication[]) => void;
  userId: string;
  sessionId: string;
  onNewSession: () => void;
}) {
  const [input, setInput] = useState('');
  const [pendingImageUri, setPendingImageUri] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  // Core: append the user's message (optionally with a photo), ask the
  // agent, then append the reply.
  async function ask(userText: string, imageUri?: string) {
    if (sending) return;
    const shownText = userText.trim();
    const backendText = shownText || (imageUri ? 'Please read this attached image.' : userText);

    setMessages((prev) => [
      ...prev,
      { id: makeId(), from: 'user', text: shownText, imageUri },
    ]);
    setSending(true);
    try {
      const { reply, cards } = await sendToAgent(
        backendText,
        { userId, sessionId },
        imageUri
      );
      setMessages((prev) => [...prev, { id: makeId(), from: 'agent', text: reply }]);
      // If the agent built medicine cards this turn, hand them up to App
      // so the 💊 Meds tab can show them.
      if (cards) onCards(cards);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          id: makeId(),
          from: 'agent',
          text: '⚠️ Could not reach the agent.\n' + String(err),
        },
      ]);
    } finally {
      setSending(false);
    }
  }

  function handleSend() {
    const text = input.trim();
    const imageUri = pendingImageUri ?? undefined;
    if (!text && !imageUri) return;
    setInput('');
    setPendingImageUri(null);
    ask(text, imageUri);
  }

  // Tapping 📷 → native Android dialog: take a photo OR pick from gallery.
  async function handlePickImage() {
    if (sending) return;

    const uri = await pickImageFromCameraOrGallery({
      title: 'Add a prescription',
      message: 'Where should the photo come from?',
      quality: 0.6,
      cameraPermissionMessage: 'Camera access is required to take a photo.',
    });
    if (!uri) return;

    setPendingImageUri(uri);
  }

  // 🔄 header button: start a brand-new conversation (fresh session id).
  // Confirm first — one stray tap shouldn't wipe grandma's chat.
  function handleNewSession() {
    if (sending) return;
    Alert.alert(
      'Start a new conversation?',
      'This clears the chat on this phone and begins a fresh session. Your medicines are kept.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Start fresh', style: 'destructive', onPress: onNewSession },
      ]
    );
  }

  return (
    <View style={styles.screen}>
      <View style={styles.headerRow}>
        <Text style={styles.header}>Chat</Text>
        <Pressable
          style={styles.newChatButton}
          onPress={handleNewSession}
          disabled={sending}
        >
          <Text style={styles.newChatText}>🔄 New chat</Text>
        </Pressable>
      </View>

      <ScrollView
        ref={scrollRef}
        contentContainerStyle={styles.chatList}
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
      >
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}

        {/* shows while we wait for the agent's reply */}
        {sending && (
          <View style={[styles.bubble, styles.bubbleAgent, styles.typingBubble]}>
            <ActivityIndicator size="small" color="#64748B" />
            <Text style={[styles.bubbleText, styles.bubbleTextAgent]}>typing…</Text>
          </View>
        )}
      </ScrollView>

      <View style={styles.inputBar}>
        {pendingImageUri && (
          <View style={styles.pendingImageRow}>
            <Image source={{ uri: pendingImageUri }} style={styles.pendingImagePreview} />
            <View style={styles.pendingImageMeta}>
              <Text style={styles.pendingImageTitle}>Photo attached</Text>
              <Text style={styles.pendingImageSubtitle}>Add a caption, then send</Text>
            </View>
            <Pressable
              style={styles.pendingImageRemoveBtn}
              onPress={() => setPendingImageUri(null)}
              disabled={sending}
            >
              <Text style={styles.pendingImageRemoveText}>✕</Text>
            </Pressable>
          </View>
        )}

        <View style={styles.inputControlsRow}>
        <Pressable
          style={styles.iconButton}
          onPress={handlePickImage}
          disabled={sending}
        >
          <Text style={styles.iconText}>📷</Text>
        </Pressable>

        <TextInput
          style={styles.input}
          placeholder="Type a message…"
          placeholderTextColor="#94A3B8"
          value={input}
          onChangeText={setInput}
          editable={!sending}
          multiline
        />

        <Pressable
          style={[styles.sendButton, sending && styles.sendButtonDisabled]}
          onPress={handleSend}
          disabled={sending}
        >
          {sending ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text style={styles.sendText}>➤</Text>
          )}
        </Pressable>
        </View>
      </View>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────
// 6. ONE TAB BUTTON (small reusable piece for the bottom bar)
// It gets told its icon/label, whether it's the active tab, and
// what to do when pressed — all as props.
// ─────────────────────────────────────────────────────────────
function TabButton({
  icon,
  label,
  active,
  onPress,
  onLongPress,
}: {
  icon: string;
  label: string;
  active: boolean;
  onPress: () => void;
  onLongPress?: () => void; // optional hidden action (e.g. open settings)
}) {
  return (
    <Pressable
      style={styles.tabButton}
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={600}
    >
      <Text style={styles.tabIcon}>{icon}</Text>
      <Text style={[styles.tabLabel, active && styles.tabLabelActive]}>
        {label}
      </Text>
    </Pressable>
  );
}

// ─────────────────────────────────────────────────────────────
// 6b. THE "CALL" SCREEN — shown when grandma ANSWERS the reminder.
// It speaks the message out loud (TTS) so it feels like a real call.
// ─────────────────────────────────────────────────────────────
function AlarmScreen({ med, onDone }: { med: AlarmMed; onDone: () => void }) {
  // Speak as soon as the screen appears; stop talking if it closes.
  useEffect(() => {
    const line = `Hello. It is time to take your ${med.name}. Please take ${med.dose} now. ${med.instructions}.`;
    Speech.speak(line, { rate: 0.9 });
    // Wrap in a block so the cleanup returns void (Speech.stop() is async;
    // a useEffect cleanup must not return a Promise).
    return () => {
      Speech.stop();
    };
  }, [med]);

  return (
    <View style={styles.alarmScreen}>
      <Text style={styles.alarmEmoji}>💊</Text>
      <Text style={styles.alarmCallTitle}>Medicine reminder</Text>
      <Text style={styles.alarmCallMed}>{med.name}</Text>
      <Text style={styles.alarmCallDose}>{med.dose}</Text>
      {!!med.instructions && (
        <Text style={styles.alarmCallInstr}>{med.instructions}</Text>
      )}

      <Pressable style={styles.alarmDoneBtn} onPress={onDone}>
        <Text style={styles.alarmDoneText}>✅ I took it</Text>
      </Pressable>
      <Pressable
        style={styles.alarmRepeatBtn}
        onPress={() => Speech.speak(`Please take your ${med.name} now.`)}
      >
        <Text style={styles.alarmRepeatText}>🔊 Say it again</Text>
      </Pressable>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────
// 6c. THE HIDDEN SETTINGS SCREEN — for the CAREGIVER, not grandma.
// Reached only by LONG-PRESSING the 💬 Chat tab, so a stray tap can't
// open it. Shows the ids that link this phone to its saved history, and
// lets the caregiver start a clean conversation.
// ─────────────────────────────────────────────────────────────
function SettingsScreen({
  userId,
  sessionId,
  onSave,
  onNewSession,
  onClose,
}: {
  userId: string;
  sessionId: string;
  onSave: (userId: string, sessionId: string) => void;
  onNewSession: () => void;
  onClose: () => void;
}) {
  const [draftUser, setDraftUser] = useState(userId);
  const [draftSession, setDraftSession] = useState(sessionId);

  return (
    <View style={styles.settingsScreen}>
      <Text style={styles.settingsTitle}>⚙️ Caregiver settings</Text>
      <Text style={styles.settingsHint}>
        These IDs link this phone to its saved chat and medicines. Most people
        never need to change them.
      </Text>

      <Text style={styles.editLabel}>User ID</Text>
      <TextInput
        style={styles.editInput}
        value={draftUser}
        onChangeText={setDraftUser}
        autoCapitalize="none"
        autoCorrect={false}
      />

      <Text style={styles.editLabel}>Session ID</Text>
      <TextInput
        style={styles.editInput}
        value={draftSession}
        onChangeText={setDraftSession}
        autoCapitalize="none"
        autoCorrect={false}
      />

      <Pressable
        style={styles.settingsSaveBtn}
        onPress={() => {
          onSave(draftUser, draftSession);
          onClose();
        }}
      >
        <Text style={styles.settingsSaveText}>Save</Text>
      </Pressable>

      <Pressable
        style={styles.settingsNewBtn}
        onPress={() =>
          Alert.alert(
            'Start a new conversation?',
            'This clears the chat on this phone and begins a fresh session. Your medicines are kept.',
            [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Start fresh',
                style: 'destructive',
                onPress: () => {
                  onNewSession();
                  onClose();
                },
              },
            ]
          )
        }
      >
        <Text style={styles.settingsNewText}>🔄 Start new conversation</Text>
      </Pressable>

      <Pressable style={styles.settingsCloseBtn} onPress={onClose}>
        <Text style={styles.settingsCloseText}>Close</Text>
      </Pressable>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────
// 7. THE APP — tabs + the alarm "call" overlay.
// ─────────────────────────────────────────────────────────────
export default function App() {
  const [tab, setTab] = useState<'chat' | 'meds'>('meds');
  // When the reminder is answered/opened, this holds the med to announce.
  const [activeAlarm, setActiveAlarm] = useState<AlarmMed | null>(null);
  // The medicine cards shown on the Meds tab. Starts EMPTY — real cards
  // come from the agent. (For a demo with seed data, use `SAMPLE_MEDS`.)
  const [meds, setMeds] = useState<Medication[]>([]);

  // Chat + identity live here now (lifted up) so they can be PERSISTED and
  // shared with the backend. userId/sessionId are created ONCE on first
  // launch and reused forever — that's what lets the agent recognise this
  // person across restarts.
  const [messages, setMessages] = useState<ChatMessage[]>(SEED_MESSAGES);
  const [userId, setUserId] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [showSettings, setShowSettings] = useState(false);

  // `ready` gates the whole UI until we've loaded from storage, so we never
  // render (or overwrite storage) with the momentary empty defaults.
  const [ready, setReady] = useState(false);

  // Load persisted state ONCE at startup. Missing ids are minted and saved.
  useEffect(() => {
    (async () => {
      let uid = await loadJSON<string>(STORE.userId, '');
      let sid = await loadJSON<string>(STORE.sessionId, '');
      if (!uid) {
        uid = newId('user');
        await saveJSON(STORE.userId, uid);
      }
      if (!sid) {
        sid = newId('session');
        await saveJSON(STORE.sessionId, sid);
      }
      setUserId(uid);
      setSessionId(sid);
      setMeds(await loadJSON<Medication[]>(STORE.meds, []));
      setMessages(await loadJSON<ChatMessage[]>(STORE.chat, SEED_MESSAGES));
      setReady(true);
    })();
  }, []);

  // Save meds + chat whenever they change — but only AFTER the initial load,
  // so the empty defaults don't clobber what we just restored.
  useEffect(() => {
    if (ready) saveJSON(STORE.meds, meds);
  }, [meds, ready]);
  useEffect(() => {
    if (ready) saveJSON(STORE.chat, messages);
  }, [messages, ready]);

  // Caregiver settings: apply + persist edited ids (blank falls back to old).
  function saveIds(nextUser: string, nextSession: string) {
    const u = nextUser.trim() || userId;
    const s = nextSession.trim() || sessionId;
    setUserId(u);
    setSessionId(s);
    saveJSON(STORE.userId, u);
    saveJSON(STORE.sessionId, s);
  }

  // Start a brand-new conversation: fresh session id + clear the chat.
  function startFreshSession() {
    const s = newId('session');
    setSessionId(s);
    saveJSON(STORE.sessionId, s);
    setMessages(SEED_MESSAGES);
  }

  // Called when the agent returns cards. Merge by name (case-insensitive):
  // a card with a name we already have replaces it; new names get appended.
  // Then jump to the Meds tab so the user sees what just got added.
  function addCards(incoming: Medication[]) {
    setMeds((prev) => {
      const byName = new Map(prev.map((m) => [m.name.toLowerCase(), m]));
      for (const card of incoming) byName.set(card.name.toLowerCase(), card);
      return Array.from(byName.values());
    });
    setTab('meds');
  }

  // Long-press → Edit: replace the medicine that has this id.
  function editMed(updated: Medication) {
    setMeds((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
  }

  // Long-press → Delete: drop the medicine. (The card cancels its own
  // alarms first, before it calls this.)
  function deleteMed(id: string) {
    setMeds((prev) => prev.filter((m) => m.id !== id));
  }

  useEffect(() => {
    setupAlarms();

    // Pull med info out of a notification and show the "call" screen.
    function answerFrom(notification: any) {
      const d = notification?.data;
      if (d?.name) {
        setActiveAlarm({
          id: String(d.medId ?? ''),
          name: String(d.name),
          dose: String(d.dose ?? ''),
          instructions: String(d.instructions ?? ''),
        });
        if (notification?.id) stopRinging(notification.id); // stop the ring
      }
    }

    // Case 1: app was launched by tapping the call (cold start).
    notifee.getInitialNotification().then((initial) => {
      if (initial) answerFrom(initial.notification);
    });

    // Case 2: events while the app is already running.
    const unsubscribe = notifee.onForegroundEvent(({ type, detail }) => {
      const { notification, pressAction } = detail;
      if (type === EventType.PRESS) answerFrom(notification);
      if (type === EventType.ACTION_PRESS) {
        if (pressAction?.id === ANSWER_ACTION) answerFrom(notification);
        if (pressAction?.id === DECLINE_ACTION && notification?.id) {
          stopRinging(notification.id);
        }
      }
    });
    return unsubscribe;
  }, []);

  // Hold the UI back until storage has loaded (a brief flash of a spinner).
  if (!ready) {
    return (
      <View style={styles.splash}>
        <ActivityIndicator size="large" color="#2563EB" />
      </View>
    );
  }

  // The hidden caregiver settings take over the screen when opened.
  if (showSettings) {
    return (
      <SettingsScreen
        userId={userId}
        sessionId={sessionId}
        onSave={saveIds}
        onNewSession={startFreshSession}
        onClose={() => setShowSettings(false)}
      />
    );
  }

  // The "call" screen takes over the whole app when active.
  if (activeAlarm) {
    return <AlarmScreen med={activeAlarm} onDone={() => setActiveAlarm(null)} />;
  }

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior="height" // Android: shrink the layout so the input rises above the keyboard
    >
      {/* Both screens stay MOUNTED; we just hide the inactive one with
          display:'none'. That preserves each screen's state across tab
          switches (so the chat history no longer vanishes), and makes the
          auto-jump-to-Meds after a scan safe — you can switch back to Chat
          and your conversation is still there. */}
      <View style={[styles.screenSlot, tab !== 'chat' && styles.hidden]}>
        <ChatScreen
          messages={messages}
          setMessages={setMessages}
          onCards={addCards}
          userId={userId}
          sessionId={sessionId}
          onNewSession={startFreshSession}
        />
      </View>
      <View style={[styles.screenSlot, tab !== 'meds' && styles.hidden]}>
        <MedicinesScreen meds={meds} onEdit={editMed} onDelete={deleteMed} ids={{ userId, sessionId }} />
      </View>

      {/* the bottom tab bar */}
      <View style={styles.tabBar}>
        <TabButton
          icon="💊"
          label="Meds"
          active={tab === 'meds'}
          onPress={() => setTab('meds')}
        />
        <TabButton
          icon="💬"
          label="Chat"
          active={tab === 'chat'}
          onPress={() => setTab('chat')}
          // Hidden caregiver gesture: press & hold Chat to open settings.
          onLongPress={() => setShowSettings(true)}
        />
      </View>

      <StatusBar style="dark" />
    </KeyboardAvoidingView>
  );
}

// ─────────────────────────────────────────────────────────────
// 8. STYLES
// ─────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#EEF2F6',
  },
  screenSlot: {
    flex: 1,
  },
  hidden: {
    display: 'none',
  },
  splash: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#EEF2F6',
  },
  settingsScreen: {
    flex: 1,
    padding: 24,
    paddingTop: 64,
    backgroundColor: '#EEF2F6',
  },
  settingsTitle: {
    fontSize: 24,
    fontWeight: '800',
    color: '#0F172A',
    marginBottom: 8,
  },
  settingsHint: {
    fontSize: 15,
    color: '#64748B',
    marginBottom: 24,
    lineHeight: 21,
  },
  settingsSaveBtn: {
    backgroundColor: '#2563EB',
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 24,
  },
  settingsSaveText: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '700',
  },
  settingsNewBtn: {
    backgroundColor: '#FEF3C7',
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 12,
  },
  settingsNewText: {
    color: '#92400E',
    fontSize: 16,
    fontWeight: '700',
  },
  settingsCloseBtn: {
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 4,
  },
  settingsCloseText: {
    color: '#64748B',
    fontSize: 16,
    fontWeight: '600',
  },
  screen: {
    flex: 1,
    backgroundColor: '#EEF2F6',
    paddingTop: 60, // leave room for the phone's status bar
  },
  header: {
    fontSize: 34,
    fontWeight: '800',
    color: '#0F172A',
    paddingHorizontal: 20,
    paddingBottom: 12,
  },
  // chat header: title on the left, 🔄 New chat on the right
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingRight: 16,
  },
  newChatButton: {
    backgroundColor: '#E2E8F0',
    borderRadius: 18,
    paddingVertical: 8,
    paddingHorizontal: 14,
    marginBottom: 12, // line up with the header's paddingBottom
  },
  newChatText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#334155',
  },
  list: {
    padding: 16,
    gap: 16,
  },
  emptyMeds: {
    fontSize: 18,
    color: '#64748B',
    textAlign: 'center',
    paddingHorizontal: 24,
    paddingTop: 40,
    lineHeight: 26,
  },
  // chat
  chatList: {
    padding: 16,
    gap: 10,
  },
  bubble: {
    maxWidth: '82%',
    borderRadius: 20,
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  bubbleAgent: {
    alignSelf: 'flex-start', // agent bubbles hug the LEFT
    backgroundColor: '#FFFFFF',
  },
  bubbleUser: {
    alignSelf: 'flex-end', // your bubbles hug the RIGHT
    backgroundColor: '#2563EB',
  },
  bubbleText: {
    fontSize: 18,
    lineHeight: 24,
  },
  bubbleTextAgent: {
    color: '#0F172A',
  },
  bubbleTextUser: {
    color: '#FFFFFF',
  },
  bubbleImage: {
    width: 200,
    height: 200,
    borderRadius: 14,
    marginBottom: 8,
  },
  typingBubble: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  // chat input bar
  inputBar: {
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#FFFFFF',
    borderTopWidth: 1,
    borderTopColor: '#E2E8F0',
  },
  inputControlsRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
  },
  pendingImageRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: 16,
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    padding: 8,
  },
  pendingImagePreview: {
    width: 48,
    height: 48,
    borderRadius: 10,
  },
  pendingImageMeta: {
    flex: 1,
  },
  pendingImageTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#0F172A',
  },
  pendingImageSubtitle: {
    fontSize: 12,
    color: '#64748B',
  },
  pendingImageRemoveBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#E2E8F0',
  },
  pendingImageRemoveText: {
    fontSize: 16,
    color: '#334155',
    fontWeight: '700',
  },
  iconButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F1F5F9',
  },
  iconText: {
    fontSize: 22,
  },
  input: {
    flex: 1,
    minHeight: 48,
    maxHeight: 120,
    borderRadius: 24,
    backgroundColor: '#F1F5F9',
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 17,
    color: '#0F172A',
  },
  sendButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#2563EB',
  },
  sendButtonDisabled: {
    backgroundColor: '#93C5FD',
  },
  sendText: {
    color: '#FFFFFF',
    fontSize: 22,
    fontWeight: '800',
  },
  // cards
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 24,
    padding: 22,
    gap: 16,
    elevation: 3,
  },
  cardTaken: {
    opacity: 0.55,
  },
  cardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  cardTopText: {
    flex: 1,
  },
  emoji: {
    fontSize: 52,
  },
  name: {
    fontSize: 30,
    fontWeight: '800',
    color: '#0F172A',
  },
  dose: {
    fontSize: 20,
    color: '#475569',
    marginTop: 2,
  },
  timesRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  timeBadge: {
    backgroundColor: '#DBEAFE',
    borderRadius: 14,
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  timeText: {
    fontSize: 20,
    fontWeight: '700',
    color: '#1D4ED8',
  },
  instructions: {
    fontSize: 20,
    color: '#334155',
  },
  alarmRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: 8,
  },
  alarmOn: {
    fontSize: 19,
    fontWeight: '700',
    color: '#0F172A',
  },
  alarmActions: {
    flexDirection: 'row',
    gap: 16,
  },
  alarmLink: {
    fontSize: 17,
    fontWeight: '700',
    color: '#2563EB',
  },
  alarmOffLink: {
    color: '#DC2626',
  },
  alarmSetButton: {
    borderWidth: 2,
    borderColor: '#2563EB',
    borderRadius: 16,
    paddingVertical: 12,
    alignItems: 'center',
  },
  alarmSetText: {
    fontSize: 18,
    fontWeight: '700',
    color: '#2563EB',
  },
  testLink: {
    fontSize: 14,
    color: '#94A3B8',
    textAlign: 'center',
  },
  scanButton: {
    backgroundColor: '#0EA5A5',
    borderRadius: 14,
    paddingVertical: 12,
    alignItems: 'center',
  },
  scanButtonDisabled: {
    opacity: 0.65,
  },
  scanButtonText: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: '800',
  },
  scanResultBox: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#99F6E4',
    backgroundColor: '#F0FDFA',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  button: {
    backgroundColor: '#2563EB',
    borderRadius: 16,
    paddingVertical: 16,
    alignItems: 'center',
  },
  buttonTaken: {
    backgroundColor: '#16A34A',
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 22,
    fontWeight: '800',
  },
  // inline edit (long-press → Edit details)
  editBox: {
    gap: 8,
  },
  editTopRow: {
    flexDirection: 'row',
    gap: 12,
    alignItems: 'flex-end',
  },
  editEmojiCol: {
    gap: 8,
  },
  editNameCol: {
    flex: 1,
    gap: 8,
  },
  editEmojiInput: {
    borderWidth: 2,
    borderColor: '#CBD5E1',
    borderRadius: 12,
    width: 64,
    paddingVertical: 8,
    fontSize: 28,
    textAlign: 'center',
    backgroundColor: '#F8FAFC',
  },
  editTimeButton: {
    borderWidth: 2,
    borderColor: '#2563EB',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignItems: 'center',
    backgroundColor: '#EFF6FF',
  },
  editTimeText: {
    fontSize: 20,
    fontWeight: '800',
    color: '#1D4ED8',
  },
  editLabel: {
    fontSize: 15,
    fontWeight: '700',
    color: '#64748B',
  },
  editInput: {
    borderWidth: 2,
    borderColor: '#CBD5E1',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 18,
    color: '#0F172A',
    backgroundColor: '#F8FAFC',
  },
  editInputMultiline: {
    minHeight: 64,
    textAlignVertical: 'top',
  },
  editActions: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 4,
  },
  editCancel: {
    flex: 1,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    backgroundColor: '#E2E8F0',
  },
  editCancelText: {
    fontSize: 18,
    fontWeight: '700',
    color: '#334155',
  },
  editSave: {
    flex: 1,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    backgroundColor: '#2563EB',
  },
  editSaveText: {
    fontSize: 18,
    fontWeight: '800',
    color: '#FFFFFF',
  },
  manageHint: {
    fontSize: 13,
    color: '#94A3B8',
    textAlign: 'center',
    paddingBottom: 8,
  },
  // alarm "call" screen
  alarmScreen: {
    flex: 1,
    backgroundColor: '#0F172A',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 28,
    gap: 12,
  },
  alarmEmoji: {
    fontSize: 96,
  },
  alarmCallTitle: {
    fontSize: 22,
    color: '#94A3B8',
    fontWeight: '700',
  },
  alarmCallMed: {
    fontSize: 44,
    color: '#FFFFFF',
    fontWeight: '800',
    textAlign: 'center',
  },
  alarmCallDose: {
    fontSize: 26,
    color: '#E2E8F0',
    textAlign: 'center',
  },
  alarmCallInstr: {
    fontSize: 22,
    color: '#CBD5E1',
    textAlign: 'center',
  },
  alarmDoneBtn: {
    marginTop: 24,
    alignSelf: 'stretch',
    backgroundColor: '#16A34A',
    borderRadius: 20,
    paddingVertical: 18,
    alignItems: 'center',
  },
  alarmDoneText: {
    color: '#FFFFFF',
    fontSize: 26,
    fontWeight: '800',
  },
  alarmRepeatBtn: {
    paddingVertical: 12,
  },
  alarmRepeatText: {
    color: '#93C5FD',
    fontSize: 18,
    fontWeight: '700',
  },
  // bottom tab bar
  tabBar: {
    flexDirection: 'row',
    backgroundColor: '#FFFFFF',
    borderTopWidth: 1,
    borderTopColor: '#E2E8F0',
    paddingTop: 8,
    paddingBottom: 14,
  },
  tabButton: {
    flex: 1,
    alignItems: 'center',
    gap: 2,
  },
  tabIcon: {
    fontSize: 24,
  },
  tabLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: '#94A3B8', // inactive: grey
  },
  tabLabelActive: {
    color: '#2563EB', // active: blue
  },
});
