/** Helper KV. Format key: user_<telegram_id>_<service_name> */

import type { Env } from './types';
import { decryptSecret, encryptSecret, isEncrypted } from './crypto';

export interface StoredService {
  service: string;
  key: string;
  secret: string;
}

export const prefixFor = (userId: number): string => `user_${userId}_`;

export const keyFor = (userId: number, service: string): string =>
  `${prefixFor(userId)}${service}`;

/** Ambil daftar nama layanan milik user (tanpa membaca nilai secret). */
export async function listServiceNames(kv: KVNamespace, userId: number): Promise<string[]> {
  const prefix = prefixFor(userId);
  const names: string[] = [];
  let cursor: string | undefined;

  do {
    const page = await kv.list({ prefix, cursor });
    for (const item of page.keys) {
      const service = item.name.slice(prefix.length);
      if (service) names.push(service);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return names.sort((a, b) => a.localeCompare(b));
}

/**
 * Ambil satu secret sudah didekripsi. Data lama berupa teks biasa otomatis
 * dimigrasikan ke ciphertext saat pertama kali dibaca.
 */
export async function getSecret(env: Env, userId: number, service: string): Promise<string | null> {
  const key = keyFor(userId, service);
  const stored = await env.AUTH_KV.get(key);
  if (stored === null) return null;

  if (!isEncrypted(stored)) {
    await env.AUTH_KV.put(key, await encryptSecret(env, stored));
    return stored;
  }
  return decryptSecret(env, stored);
}

/** Simpan secret dalam bentuk terenkripsi. */
export async function saveSecret(
  env: Env,
  userId: number,
  service: string,
  secret: string,
): Promise<void> {
  await env.AUTH_KV.put(keyFor(userId, service), await encryptSecret(env, secret));
}

/** Ambil daftar layanan beserta secret (sudah didekripsi) untuk /export. */
export async function listServices(env: Env, userId: number): Promise<StoredService[]> {
  const services: StoredService[] = [];
  for (const service of await listServiceNames(env.AUTH_KV, userId)) {
    const secret = await getSecret(env, userId, service);
    if (secret !== null) services.push({ service, key: keyFor(userId, service), secret });
  }
  return services;
}

export async function removeSecret(env: Env, userId: number, service: string): Promise<void> {
  await env.AUTH_KV.delete(keyFor(userId, service));
}

export async function removeAll(env: Env, userId: number): Promise<void> {
  const keys = await listServiceNames(env.AUTH_KV, userId);
  await Promise.all(keys.map((service) => env.AUTH_KV.delete(keyFor(userId, service))));
}

/**
 * State sementara untuk alur berbasis tombol yang butuh input teks
 * (mis. tombol "Tambah" lalu user mengirim `<service> <secret>`).
 * Key memakai chat_id agar state tidak bocor antar chat.
 */
export type PendingAction = { type: 'add' } | { type: 'import'; replace: boolean };

const pendingKey = (chatId: number): string => `pending_${chatId}`;

export async function setPendingAction(
  kv: KVNamespace,
  chatId: number,
  action: PendingAction,
  ttlSeconds = 300,
): Promise<void> {
  await kv.put(pendingKey(chatId), JSON.stringify(action), { expirationTtl: ttlSeconds });
}

export async function getPendingAction(
  kv: KVNamespace,
  chatId: number,
): Promise<PendingAction | null> {
  const raw = await kv.get(pendingKey(chatId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PendingAction;
  } catch {
    return null;
  }
}

export async function clearPendingAction(kv: KVNamespace, chatId: number): Promise<void> {
  await kv.delete(pendingKey(chatId));
}
