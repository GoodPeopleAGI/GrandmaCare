import { registerRootComponent } from 'expo';
import notifee, { EventType } from '@notifee/react-native';

import App from './App';
import { DECLINE_ACTION } from './alarm';

// Handle alarm button taps when the app is in the BACKGROUND or killed.
// (Tapping "Answer" / the call body opens the app via fullScreenAction;
// the app itself then stops the ring and speaks — see App.tsx.)
notifee.onBackgroundEvent(async ({ type, detail }) => {
  const { notification, pressAction } = detail;
  if (
    type === EventType.ACTION_PRESS &&
    pressAction?.id === DECLINE_ACTION &&
    notification?.id
  ) {
    await notifee.cancelNotification(notification.id);
  }
});

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
