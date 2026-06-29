import notifee, {
  AndroidCategory,
  AndroidImportance,
  AndroidNotificationSetting,
  AndroidVisibility,
  RepeatFrequency,
  TimestampTrigger,
  TriggerType,
} from '@notifee/react-native';

// The minimal data an alarm needs (a slimmed-down Medication).
export type AlarmMed = {
  id: string;
  name: string;
  dose: string;
  instructions: string;
};

export const ALARM_CHANNEL = 'med-call-alarm';
export const ANSWER_ACTION = 'answer';
export const DECLINE_ACTION = 'decline';

// Ask permission + create the high-importance "call" channel. Run once.
export async function setupAlarms() {
  await notifee.requestPermission();
  await notifee.createChannel({
    id: ALARM_CHANNEL,
    name: 'Medicine call reminders',
    importance: AndroidImportance.HIGH,
    sound: 'default',
    vibration: true,
    vibrationPattern: [300, 500, 300, 500],
    visibility: AndroidVisibility.PUBLIC,
    bypassDnd: true,
  });
}

// The notification that behaves like an INCOMING CALL: full-screen over
// the lockscreen, looping ring, can't be swiped away, Answer/Decline.
function callNotification(med: AlarmMed) {
  return {
    id: `alarm-${med.id}`,
    title: '📞 Medicine reminder',
    body: `Time to take ${med.name} (${med.dose})`,
    // data must be strings — we read these back when she "answers".
    data: {
      medId: med.id,
      name: med.name,
      dose: med.dose,
      instructions: med.instructions,
    },
    android: {
      channelId: ALARM_CHANNEL,
      category: AndroidCategory.CALL,
      importance: AndroidImportance.HIGH,
      fullScreenAction: { id: 'default' }, // launch app over the lockscreen
      pressAction: { id: 'default', launchActivity: 'default' },
      ongoing: true, // can't be swiped away
      autoCancel: false,
      loopSound: true, // keep ringing until answered/declined
      actions: [
        {
          title: '✅ Answer',
          pressAction: { id: ANSWER_ACTION, launchActivity: 'default' },
        },
        { title: '✖ Decline', pressAction: { id: DECLINE_ACTION } },
      ],
    },
  };
}

// Ring RIGHT NOW (no scheduling) — the most reliable way to test the
// call. Returns 'ok', or a message explaining what's blocking it.
export async function ringNow(med: AlarmMed): Promise<string> {
  await setupAlarms(); // make sure permission + channel exist
  const settings = await notifee.getNotificationSettings();
  if (settings.authorizationStatus === 0) {
    return 'Notifications are turned OFF for GrandmaCare. Enable them in Settings → Apps → GrandmaCare → Notifications, then try again.';
  }
  await notifee.displayNotification(callNotification(med));
  return 'ok';
}

// Exact alarms (Android 12+) need a special "Alarms & reminders" permission
// to fire at the precise minute. Returns true if it's granted.
async function exactAlarmAllowed(): Promise<boolean> {
  const settings = await notifee.getNotificationSettings();
  return settings.android.alarm === AndroidNotificationSetting.ENABLED;
}

// Send the user to the system screen to grant exact-alarm permission.
export async function openExactAlarmSettings() {
  await notifee.openAlarmPermissionSettings();
}

// Ring once in N seconds — for TESTING the scheduled path.
export async function scheduleTestCall(med: AlarmMed, seconds = 10): Promise<string> {
  const exact = await exactAlarmAllowed();
  const trigger: TimestampTrigger = {
    type: TriggerType.TIMESTAMP,
    timestamp: Date.now() + seconds * 1000,
    ...(exact ? { alarmManager: { allowWhileIdle: true } } : {}),
  };
  return notifee.createTriggerNotification(callNotification(med), trigger);
}

// Ring EVERY DAY at the chosen time.
export async function scheduleDailyCall(med: AlarmMed, when: Date): Promise<string> {
  // Notifee requires a FUTURE timestamp; if today's time already passed,
  // start tomorrow.
  const next = new Date(when);
  if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);

  const exact = await exactAlarmAllowed();
  const trigger: TimestampTrigger = {
    type: TriggerType.TIMESTAMP,
    timestamp: next.getTime(),
    repeatFrequency: RepeatFrequency.DAILY,
    ...(exact ? { alarmManager: { allowWhileIdle: true } } : {}),
  };
  return notifee.createTriggerNotification(callNotification(med), trigger);
}

// Cancel a scheduled alarm (used by "Turn off" / before rescheduling).
export async function cancelAlarm(id: string) {
  await notifee.cancelNotification(id);
}

// Stop a currently-ringing call (used when answered/declined).
export async function stopRinging(notificationId: string) {
  await notifee.cancelNotification(notificationId);
}
