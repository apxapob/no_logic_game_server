# Android push delivery

Push delivery is optional. Set `FCM_ENABLED=true` and
`GOOGLE_APPLICATION_CREDENTIALS=/etc/general-connect/firebase-service-account.json`
in the service environment. Keep that JSON outside the repository and release
directories, readable only by the service account. Never paste its contents into
logs, protocol payloads or Git. Firebase Admin uses Application Default Credentials.
No credentials are loaded and no FCM requests are made when push is disabled.

An enabled server advertises `onConnected.data.pushNotifications: true`.
Authenticated clients may send:

- `setPushDevice`: `{deviceId: UUID, token: string | null, foreground: boolean, language?: string}`.
  A null token unregisters this installation. A new token replaces its previous
  token; each account retains at most four devices. Tokens never enter public DTOs
  and are redacted in verbose protocol logs.
- `notifyPlayers`: `{to: UUID[], eventId: string, title: string, body: string,
  translations?: {[language: string]: {title: string, body: string}}}`. Only the active owner of a started
  fixed-roster game may notify original participants. The relay does not interpret
  gameplay. The relay selects the translation for each device's registered game
  language (default `en`), falling back to the supplied title/body when absent.
  FCM receives literal text, so the Android system locale cannot override it.
  Translation maps are bounded to 20 entries; client language changes refresh
  registration while connected, and reconnect publishes the current preference.

The relay skips the sender and connected foreground devices, limits requests to
one per room per 30 seconds and at most 32 provider calls in flight, and remembers
the latest 128 event IDs per room to suppress duplicates across host changes.
Notifications expire after five minutes and replace older notifications from the
same room. Delivery is best effort: transient errors are isolated from gameplay;
permanently invalid tokens are removed. Provider errors never include token values
in server logs. Disabled delivery and rate limiting return `push_unavailable` and
`push_rate_limited`; clients must not treat them as gameplay errors.

Registrations live in memory with existing accounts and expire with them. Restarting
the server requires clients to register again. This does not provide correspondence
games: rooms still disappear after the last active participant leaves. Do not
restart production to enable this while rooms are active without coordinating it.

Validation: `npm run check` includes push authorization, registration rotation,
revocation, foreground suppression, offline delivery, deduplication and log-redaction
tests. A real-device smoke test additionally requires a valid service account and
the target device's current FCM token.
