import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
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
//     `ipconfig`), e.g. http://192.168.1.50:8000 — NOT localhost.
//   • AGENT_ID must match Agent(id=...) in agents.py (we used "agent").
// The `?? '...'` is a fallback used only if the .env value is missing.
// ═══════════════════════════════════════════════════════════════
const AGENT_OS_URL = (
  process.env.EXPO_PUBLIC_AGENT_OS_URL ?? 'http://192.168.1.50:8000'
).replace(/\/+$/, ''); // strip any trailing slash so we don't get "//agents"
const AGENT_ID = 'agent';

// Tiny helper so every chat message gets a unique id.
function makeId(): string {
  return Math.random().toString(36).slice(2);
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

// first prescription time as a Date — the picker's DEFAULT value
function defaultTimeFor(med: Medication): Date {
  const { hour, minute } = parseTime(med.times[0] ?? '8:00 AM');
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

// ─────────────────────────────────────────────────────────────
// 3. ONE CARD — now with an editable alarm
// ─────────────────────────────────────────────────────────────
function MedicationCard({ med }: { med: Medication }) {
  const [taken, setTaken] = useState(false);
  const [alarmTime, setAlarmTime] = useState<Date | null>(null);
  const [notifId, setNotifId] = useState<string | null>(null);
  const [showPicker, setShowPicker] = useState(false);

  // Schedule (or reschedule) the daily call-alarm for a chosen time.
  async function setAlarm(when: Date) {
    if (notifId) await cancelAlarm(notifId); // remove the old one first
    const id = await scheduleDailyCall(toAlarmMed(med), when);
    setNotifId(id);
    setAlarmTime(when);
  }

  async function turnOff() {
    if (notifId) await cancelAlarm(notifId);
    setNotifId(null);
    setAlarmTime(null);
  }

  // Runs when the time picker closes (Android's picker is one-shot).
  function onPickTime(event: DateTimePickerEvent, date?: Date) {
    setShowPicker(false);
    if (event.type === 'set' && date) setAlarm(date);
  }

  // Tapping "Test" → choose ring now, or a call in 10s (so you can
  // lock/leave the phone and feel it arrive in the background).
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

  return (
    <View style={[styles.card, taken && styles.cardTaken]}>
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

      <Text style={styles.instructions}>{med.instructions}</Text>

      {/* ALARM CONTROLS — tap to set a custom time, or accept the default */}
      {alarmTime ? (
        <View style={styles.alarmRow}>
          <Text style={styles.alarmOn}>🔔 Daily at {formatTime(alarmTime)}</Text>
          <View style={styles.alarmActions}>
            <Pressable onPress={() => setShowPicker(true)}>
              <Text style={styles.alarmLink}>Change</Text>
            </Pressable>
            <Pressable onPress={turnOff}>
              <Text style={[styles.alarmLink, styles.alarmOffLink]}>Turn off</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <Pressable style={styles.alarmSetButton} onPress={() => setShowPicker(true)}>
          <Text style={styles.alarmSetText}>🔔 Set reminder (default {med.times[0]})</Text>
        </Pressable>
      )}

      {/* choose: ring now, or schedule a call in 10s */}
      <Pressable onPress={handleTest}>
        <Text style={styles.testLink}>▶ Test this alarm</Text>
      </Pressable>

      {showPicker && (
        <DateTimePicker
          value={alarmTime ?? defaultTimeFor(med)}
          mode="time"
          display="default"
          onChange={onPickTime}
        />
      )}

      <Pressable
        style={[styles.button, taken && styles.buttonTaken]}
        onPress={() => setTaken(!taken)}
      >
        <Text style={styles.buttonText}>
          {taken ? '✓ Taken' : 'Mark as taken'}
        </Text>
      </Pressable>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────
// 4. THE MEDS SCREEN (your Phase 1 cards, just moved into their
// own component so it can live behind the 💊 Meds tab)
// ─────────────────────────────────────────────────────────────
function MedicinesScreen() {
  return (
    <View style={styles.screen}>
      <Text style={styles.header}>Today's Medicines</Text>
      <ScrollView contentContainerStyle={styles.list}>
        {SAMPLE_MEDS.map((med) => (
          <MedicationCard key={med.id} med={med} />
        ))}
      </ScrollView>
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
// Sends one message to your AgentOS run endpoint and returns the
// agent's reply text. Uses multipart/form-data (what the endpoint
// expects) and stream=false (one request → one JSON reply).
// ─────────────────────────────────────────────────────────────
async function sendToAgent(message: string, imageUri?: string): Promise<string> {
  const form = new FormData();
  form.append('message', message);
  form.append('stream', 'false');
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
  // Agno puts the agent's reply text in `content`.
  return typeof data?.content === 'string' ? data.content : JSON.stringify(data);
}

// ─────────────────────────────────────────────────────────────
// 5d. THE CHAT SCREEN — bubbles + a real input bar wired to the
// agent. Type → your bubble appears instantly → agent replies.
// ─────────────────────────────────────────────────────────────
function ChatScreen() {
  const [messages, setMessages] = useState<ChatMessage[]>(SEED_MESSAGES);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  // Core: append the user's message (optionally with a photo), ask the
  // agent, then append the reply.
  async function ask(userText: string, imageUri?: string) {
    if (sending) return;
    setMessages((prev) => [
      ...prev,
      { id: makeId(), from: 'user', text: userText, imageUri },
    ]);
    setSending(true);
    try {
      const reply = await sendToAgent(userText, imageUri);
      setMessages((prev) => [...prev, { id: makeId(), from: 'agent', text: reply }]);
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
    if (!text) return;
    setInput('');
    ask(text);
  }

  // Tapping 📷 → native Android dialog: take a photo OR pick from gallery.
  function handlePickImage() {
    if (sending) return;
    Alert.alert('Add a prescription', 'Where should the photo come from?', [
      { text: '📷 Take Photo', onPress: () => pickFrom('camera') },
      { text: '🖼️ Choose from Gallery', onPress: () => pickFrom('gallery') },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }

  async function pickFrom(source: 'camera' | 'gallery') {
    let result: ImagePicker.ImagePickerResult;

    if (source === 'camera') {
      // Camera needs runtime permission; the gallery picker does not.
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('Permission needed', 'Camera access is required to take a photo.');
        return;
      }
      result = await ImagePicker.launchCameraAsync({ quality: 0.6 });
    } else {
      result = await ImagePicker.launchImageLibraryAsync({ quality: 0.6 });
    }

    if (result.canceled) return; // user backed out
    const uri = result.assets[0].uri;
    ask('Here is my prescription. Please read it and list the medicines simply.', uri);
  }

  return (
    <View style={styles.screen}>
      <Text style={styles.header}>Chat</Text>

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
}: {
  icon: string;
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable style={styles.tabButton} onPress={onPress}>
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
    return () => Speech.stop();
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
// 7. THE APP — tabs + the alarm "call" overlay.
// ─────────────────────────────────────────────────────────────
export default function App() {
  const [tab, setTab] = useState<'chat' | 'meds'>('meds');
  // When the reminder is answered/opened, this holds the med to announce.
  const [activeAlarm, setActiveAlarm] = useState<AlarmMed | null>(null);

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

  // The "call" screen takes over the whole app when active.
  if (activeAlarm) {
    return <AlarmScreen med={activeAlarm} onDone={() => setActiveAlarm(null)} />;
  }

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior="height" // Android: shrink the layout so the input rises above the keyboard
    >
      {/* the active screen fills all space above the tab bar */}
      {tab === 'chat' ? <ChatScreen /> : <MedicinesScreen />}

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
  list: {
    padding: 16,
    gap: 16,
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
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#FFFFFF',
    borderTopWidth: 1,
    borderTopColor: '#E2E8F0',
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
