// ─────────────────────────────────────────────────────────────
// PERSISTENCE — everything the app should REMEMBER across restarts.
//
// We use `expo-file-system`, which ships with the Expo SDK and is ALREADY
// in the dev client — so this needs no extra native module and no rebuild,
// just a Metro reload. Each key is stored as a small JSON file in the app's
// private document directory (safe from being wiped by the OS).
//
// Why this exists: without it, useState() starts empty every launch, so
// meds + chat vanish on reload and the agent can't recognise the user.
// ─────────────────────────────────────────────────────────────
import { File, Paths } from 'expo-file-system';

// One place for every storage key, so we never mistype a string.
// Each becomes a file: e.g. "gc.meds" → <documents>/gc.meds.json
export const STORE = {
  userId: 'gc.userId',
  sessionId: 'gc.sessionId',
  meds: 'gc.meds',
  chat: 'gc.chat',
} as const;

// The file handle for a given key, under the app's document directory.
function fileFor(key: string): File {
  return new File(Paths.document, key + '.json');
}

// Read a JSON value; return `fallback` if the file is missing or unreadable.
export async function loadJSON<T>(key: string, fallback: T): Promise<T> {
  try {
    const f = fileFor(key);
    if (!f.exists) return fallback;
    const raw = f.textSync();
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

// Write a JSON value (creating the file first if needed). Errors are
// swallowed — a failed save is non-fatal for our little app.
export async function saveJSON<T>(key: string, value: T): Promise<void> {
  try {
    const f = fileFor(key);
    if (!f.exists) f.create();
    f.write(JSON.stringify(value));
  } catch {
    // ignore
  }
}

// A reasonably-unique id: a prefix + timestamp + randomness. Not a formal
// UUID (RN has no crypto by default), but collisions are effectively
// impossible for our per-phone user/session ids.
export function newId(prefix: string): string {
  return (
    prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
  );
}
