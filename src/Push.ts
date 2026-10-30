import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';

export interface PushNotification { title: string; body: string; roomId: string; eventId: string }
export type PushSender = (token: string, notification: PushNotification) => Promise<'sent' | 'invalid'>;

/** Credentials stay in ADC (GOOGLE_APPLICATION_CREDENTIALS), never in protocol messages. */
export function createPushSender(): PushSender {
  const app = initializeApp({ credential: applicationDefault() }, 'game-push');
  const messaging = getMessaging(app);
  return async (token, notification) => {
    try {
      await messaging.send({ token,
        notification: { title: notification.title, body: notification.body },
        data: { roomId: notification.roomId, eventId: notification.eventId },
        android: { priority: 'high', ttl: 300000,
          collapseKey: notification.roomId,
          notification: { channelId: 'game_updates', tag: notification.roomId,
            title: notification.title, body: notification.body } },
      });
      return 'sent';
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') return 'invalid';
      // Do not expose provider errors containing registration tokens or credentials.
      throw new Error('Push delivery failed');
    }
  };
}
