// Envelope encryption for provider keys at rest. The master key comes from ARCWISE_ENCRYPTION_KEY.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface Sealed { v: 1; wrapped: string; wiv: string; wtag: string; iv: string; tag: string; ct: string }

function masterKey(): Buffer | null {
  const raw = process.env.ARCWISE_ENCRYPTION_KEY;
  if (!raw) return null;
  const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (buf.length !== 32) throw new Error('ARCWISE_ENCRYPTION_KEY must be 32 bytes, as 64 hex characters or base64.');
  return buf;
}

export const canStoreSecrets = () => !!masterKey();

function gcm(key: Buffer, data: Buffer) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(data), c.final()]);
  return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') };
}
function ungcm(key: Buffer, iv: string, tag: string, ct: string) {
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]);
}

export function seal(secret: string): Sealed {
  const mk = masterKey();
  if (!mk) throw new Error('Set ARCWISE_ENCRYPTION_KEY to save provider keys.');
  const dataKey = randomBytes(32);
  const inner = gcm(dataKey, Buffer.from(secret, 'utf8'));
  const outer = gcm(mk, dataKey);
  return { v: 1, wrapped: outer.ct, wiv: outer.iv, wtag: outer.tag, ...inner };
}

export function unseal(s: Sealed): string {
  const mk = masterKey();
  if (!mk) throw new Error('ARCWISE_ENCRYPTION_KEY is not set.');
  const dataKey = ungcm(mk, s.wiv, s.wtag, s.wrapped);
  return ungcm(dataKey, s.iv, s.tag, s.ct).toString('utf8');
}
