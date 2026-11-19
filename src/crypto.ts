/**
 * Enkripsi secret TOTP di KV memakai AES-GCM (Web Crypto API bawaan Worker).
 *
 * Nilai yang disimpan: enc:v1:<iv-base64>.<ciphertext-base64>
 * Secret TOTP harus bisa dikembalikan ke plaintext untuk membuat OTP, jadi
 * tidak boleh di-hash (satu arah). Kunci rahasia disimpan sebagai Worker
 * secret ENCRYPTION_KEY, bukan di KV / wrangler.toml.
 */

import type { Env } from './types';

const PREFIX = 'enc:v1:';
const IV_BYTES = 12;

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function encryptionKey(env: Env): Promise<CryptoKey> {
  const raw = env.ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      'ENCRYPTION_KEY belum diset. Jalankan: npx wrangler secret put ENCRYPTION_KEY',
    );
  }

  let keyBytes: Uint8Array;
  try {
    keyBytes = fromBase64(raw.trim());
  } catch {
    keyBytes = new TextEncoder().encode(raw.trim());
  }
  // Basis kunci bukan 32 byte diubah ke 32 byte memakai SHA-256.
  if (keyBytes.length !== 32) {
    const digest = await crypto.subtle.digest('SHA-256', keyBytes);
    keyBytes = new Uint8Array(digest);
  }

  return crypto.subtle.importKey(
    'raw',
    keyBytes.buffer as ArrayBuffer,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** true bila nilai KV sudah berbentuk ciphertext (bukan teks lama). */
export function isEncrypted(stored: string): boolean {
  return stored.startsWith(PREFIX);
}

export async function encryptSecret(env: Env, plaintext: string): Promise<string> {
  const key = await encryptionKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const data = new TextEncoder().encode(plaintext);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data),
  );
  return `${PREFIX}${toBase64(iv)}.${toBase64(ciphertext)}`;
}

export async function decryptSecret(env: Env, stored: string): Promise<string> {
  // Data lama (teks biasa) tetap bisa dibaca; akan dimigrasikan oleh store.ts.
  if (!isEncrypted(stored)) return stored;

  const payload = stored.slice(PREFIX.length);
  const [ivPart, ciphertextPart] = payload.split('.');
  if (!ivPart || !ciphertextPart) {
    throw new Error('Format secret terenkripsi tidak valid.');
  }

  const key = await encryptionKey(env);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(ivPart) },
    key,
    fromBase64(ciphertextPart),
  );
  return new TextDecoder().decode(plaintext);
}
