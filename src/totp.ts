/**
 * Implementasi TOTP (RFC 6238) memakai Web Crypto API bawaan Cloudflare Workers.
 * Tidak perlu dependency npm: HMAC-SHA1 + dynamic truncation.
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export interface TotpOptions {
  period?: number; // detik, default 30
  digits?: number; // jumlah digit, default 6
  timestamp?: number; // ms, default Date.now()
}

/**
 * Membersihkan secret: menerima Base32 biasa maupun URL otpauth://.
 * Menghasilkan Base32 tanpa padding, huruf kapital.
 */
export function normalizeSecret(input: string): string {
  let secret = input.trim();

  if (secret.startsWith('otpauth://')) {
    let parsed: URL;
    try {
      parsed = new URL(secret);
    } catch {
      throw new Error('URL otpauth:// tidak valid.');
    }
    const fromUrl = parsed.searchParams.get('secret');
    if (!fromUrl) throw new Error('Parameter secret tidak ditemukan di URL otpauth://.');
    secret = fromUrl;
  }

  secret = secret.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();

  if (!/^[A-Z2-7]+$/.test(secret)) {
    throw new Error('Secret harus Base32 (huruf A-Z dan angka 2-7).');
  }
  if (secret.length < 8 || secret.length > 256) {
    throw new Error('Panjang secret tidak valid (8-256 karakter Base32).');
  }
  return secret;
}

function base32Decode(secret: string): Uint8Array {
  let bits = '';
  for (const char of secret) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) throw new Error('Karakter Base32 tidak valid: ' + char);
    bits += index.toString(2).padStart(5, '0');
  }

  const bytes = new Uint8Array(Math.floor(bits.length / 8));
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  }
  return bytes;
}

/** Hasilkan kode TOTP untuk counter/time bucket saat ini. */
export async function generateTOTP(secret: string, options: TotpOptions = {}): Promise<string> {
  const { period = 30, digits = 6, timestamp = Date.now() } = options;
  if (period <= 0) throw new Error('Period harus > 0.');
  if (digits < 6 || digits > 9) throw new Error('Digits harus antara 6 dan 9.');

  const counter = BigInt(Math.floor(timestamp / 1000 / period));

  // Counter 8 byte, big-endian, sesuai RFC 4226.
  const counterBytes = new Uint8Array(8);
  new DataView(counterBytes.buffer).setBigUint64(0, counter, false);

  const keyBytes = base32Decode(normalizeSecret(secret));
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes.buffer as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );

  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, counterBytes));

  // Dynamic truncation (RFC 4226, pasal 5.4).
  const offset = signature[signature.length - 1] & 0x0f;
  const binary =
    ((signature[offset] & 0x7f) << 24) |
    (signature[offset + 1] << 16) |
    (signature[offset + 2] << 8) |
    signature[offset + 3];

  return (binary % 10 ** digits).toString().padStart(digits, '0');
}

/** Sisa detik sebelum kode berganti. */
export function secondsRemaining(period = 30, timestamp = Date.now()): number {
  return period - (Math.floor(timestamp / 1000) % period);
}
