export interface ProtocolMessage { method: string; data?: unknown }
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export const isUuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const name = (value: unknown): boolean => typeof value === 'string' && value.trim().length > 0 && value.length <= 64;
const password = (value: unknown): boolean => value === undefined || value === null || (typeof value === 'string' && value.length <= 128);
const language = (value: unknown): value is string => typeof value === 'string' && /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/.test(value);
function translations(value: unknown): boolean {
  return value === undefined || (isRecord(value) && Object.keys(value).length <= 20 &&
    Object.entries(value).every(([key, text]) => language(key) && isRecord(text) &&
      typeof text.title === 'string' && text.title.trim().length > 0 && text.title.length <= 100 &&
      typeof text.body === 'string' && text.body.trim().length > 0 && text.body.length <= 500));
}
function notice(value: unknown): boolean {
  return value === null || (isRecord(value) && typeof value.eventId === 'string' && /^[A-Za-z0-9_.:\-]{1,128}$/.test(value.eventId) &&
    Number.isSafeInteger(value.at) && Number(value.at) >= 0 && Array.isArray(value.to) && value.to.length <= 64 && value.to.every(isUuid) &&
    typeof value.title === 'string' && value.title.length > 0 && value.title.length <= 100 &&
    typeof value.body === 'string' && value.body.length > 0 && value.body.length <= 500 && translations(value.translations));
}
function boundedJson(value: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(item => boundedJson(item, depth + 1));
  return isRecord(value) && Object.values(value).every(item => boundedJson(item, depth + 1));
}
export function validateMessage(value: unknown, maxRoomPlayers: number, maxAccounts: number): value is ProtocolMessage {
  if (!isRecord(value) || !Object.hasOwn(value, 'method') || typeof value.method !== 'string') return false;
  const d = value.data;
  const ids = (v: unknown): boolean => Array.isArray(v) && v.length <= maxAccounts && v.every(isUuid) && new Set(v).size === v.length;
  // Normalize only envelopes whose entire tree is bounded, including extension fields.
  if (!boundedJson(value)) return false;
  switch (value.method) {
    case 'getSavedRooms': return isRecord(d) && Array.isArray(d.ids) && d.ids.length <= 20 && d.ids.every(isUuid);
    case 'getSession': return isRecord(d) && isUuid(d.requestId);
    case 'getSessionChunk': return isRecord(d) && isUuid(d.requestId) && Number.isSafeInteger(d.revision) && Number(d.revision) >= 0 && Number.isSafeInteger(d.offset) && Number(d.offset) >= 0;
    case 'beginSession': return isRecord(d) && isUuid(d.requestId) && Number.isSafeInteger(d.revision) && Number(d.revision) >= 0 &&
      Number.isSafeInteger(d.generation) && Number(d.generation) >= 0 && Number.isSafeInteger(d.size) && Number(d.size) > 0;
    case 'commitSession': return isRecord(d) && isUuid(d.requestId) && notice(d.scheduled) && notice(d.immediate);
    case 'authenticate': return isRecord(d) && (d.name === undefined || name(d.name)) &&
      (d.playerId === undefined || isUuid(d.playerId)) && (d.password === undefined || (typeof d.password === 'string' && password(d.password)));
    case 'Pong': return typeof d === 'number' && Number.isFinite(d);
    case 'setPushDevice': return isRecord(d) && isUuid(d.deviceId) &&
      (d.language === undefined || language(d.language)) &&
      typeof d.foreground === 'boolean' && (d.token === null ||
        (typeof d.token === 'string' && /^[A-Za-z0-9_:\-]{20,4096}$/.test(d.token)));
    case 'notifyPlayers': return isRecord(d) && ids(d.to) && (d.to as unknown[]).length > 0 &&
      typeof d.eventId === 'string' && /^[A-Za-z0-9_.:\-]{1,128}$/.test(d.eventId) &&
      typeof d.title === 'string' && d.title.trim().length > 0 && d.title.length <= 100 &&
      typeof d.body === 'string' && d.body.trim().length > 0 && d.body.length <= 500 &&
      translations(d.translations);
    case 'getRooms': return d === undefined || d === null || (isRecord(d) && (d.after === undefined || isUuid(d.after)));
    case 'leaveRoom': case 'requestGameState': return d === undefined || d === null;
    case 'getPlayers': return d === undefined || d === null || ids(d);
    case 'changeName': return name(d);
    case 'sendChatMsg': return typeof d === 'string' && d.length <= 2048;
    case 'enterRoom': return isRecord(d) && isUuid(d.roomId) && password(d.password);
    case 'createRoom': return isRecord(d) && (d.binaryRelay === undefined || typeof d.binaryRelay === 'boolean') && name(d.name) && Number.isInteger(d.maxPlayers) &&
      typeof d.maxPlayers === 'number' && d.maxPlayers >= 1 && d.maxPlayers <= maxRoomPlayers && password(d.password);
    case 'updateRoom': return isRecord(d) && (Object.hasOwn(d, 'name') || Object.hasOwn(d, 'maxPlayers') || Object.hasOwn(d, 'password') || Object.hasOwn(d, 'joinClosed')) &&
      (d.joinClosed === undefined || typeof d.joinClosed === 'boolean') &&
      (d.name === undefined || name(d.name)) &&
      (d.maxPlayers === undefined || (Number.isInteger(d.maxPlayers) && typeof d.maxPlayers === 'number' &&
        d.maxPlayers >= 1 && d.maxPlayers <= maxRoomPlayers)) && password(d.password);
    case 'shareGameState': return isRecord(d) && Object.hasOwn(d, 'gamestate') && (d.to === undefined || ids(d.to));
    case 'sendTo': return isRecord(d) && ids(d.to) && Object.hasOwn(d, 'msg');
    case 'startGame': case 'sendToRoom': case 'setRoomMeta': return d !== undefined;
    default: return false;
  }
}
