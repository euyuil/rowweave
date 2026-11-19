import { randomBytes } from 'node:crypto';

const alphabet = '0123456789bcdfghjkmnpqrstvwxz';
const base = BigInt(alphabet.length);

export function newId(kind: 'tbl' | 'fld' | 'rec'): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(Date.now(), 0, 6);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  let value = (bytes.readBigUInt64BE(0) << 64n) | bytes.readBigUInt64BE(8);
  let suffix = '';
  while (value > 0n) {
    suffix = alphabet[Number(value % base)]! + suffix;
    value /= base;
  }
  return kind + '_' + suffix.padStart(27, alphabet[0]!);
}
