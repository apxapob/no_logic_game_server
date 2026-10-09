export interface ProtocolMessage { method: string; data?: unknown }
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export const isUuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const name = (value: unknown): boolean => typeof value === 'string' && value.trim().length > 0 && value.length <= 64;
const password = (value: unknown): boolean => value === undefined || value === null || (typeof value === 'string' && value.length <= 128);
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
  if (d !== undefined && !boundedJson(d)) return false;
  switch (value.method) {
    case 'authenticate': return isRecord(d) && (d.name === undefined || name(d.name)) &&
      (d.playerId === undefined || isUuid(d.playerId)) && (d.password === undefined || (typeof d.password === 'string' && password(d.password)));
    case 'Pong': return typeof d === 'number' && Number.isFinite(d);
    case 'getRooms': case 'leaveRoom': case 'requestGameState': return d === undefined || d === null;
    case 'getPlayers': return d === undefined || d === null || ids(d);
    case 'changeName': return name(d);
    case 'sendChatMsg': return typeof d === 'string' && d.length <= 2048;
    case 'enterRoom': return isRecord(d) && isUuid(d.roomId) && password(d.password);
    case 'createRoom': return isRecord(d) && name(d.name) && Number.isInteger(d.maxPlayers) &&
      typeof d.maxPlayers === 'number' && d.maxPlayers >= 1 && d.maxPlayers <= maxRoomPlayers && password(d.password);
    case 'shareGameState': return isRecord(d) && Object.hasOwn(d, 'gamestate') && (d.to === undefined || ids(d.to));
    case 'sendTo': return isRecord(d) && ids(d.to) && Object.hasOwn(d, 'msg');
    case 'startGame': case 'sendToRoom': case 'setRoomMeta': return d !== undefined;
    default: return false;
  }
}
