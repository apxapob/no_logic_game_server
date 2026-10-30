import { isUuid } from './MessageHandler';

// Opt-in v1: byte 0 = version, bytes 1..16 = target UUID (zeroes = room).
// UUID bytes follow canonical hexadecimal pair order, without GUID endian swaps.
// On delivery the relay replaces the target with the authenticated sender UUID.
export const BINARY_HEADER_BYTES = 17;
export function binaryTarget(bytes: Buffer): string | null | undefined {
  if (bytes.length <= BINARY_HEADER_BYTES || bytes[0] !== 1) return undefined;
  const address = bytes.subarray(1, BINARY_HEADER_BYTES);
  if (address.every(byte => byte === 0)) return null;
  const hex = address.toString('hex');
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return isUuid(id) ? id : undefined;
}
export function binaryFrom(bytes: Buffer, playerId: string): Buffer {
  const result = Buffer.from(bytes);
  Buffer.from(playerId.replaceAll('-', ''), 'hex').copy(result, 1);
  return result;
}
