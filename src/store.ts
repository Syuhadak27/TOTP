/** Helper KV. Format key: user_<telegram_id>_<service_name> */

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

/** Ambil daftar layanan beserta secret (dipakai /list dan /export). */
export async function listServices(kv: KVNamespace, userId: number): Promise<StoredService[]> {
  const prefix = prefixFor(userId);
  const services: StoredService[] = [];

  for (const service of await listServiceNames(kv, userId)) {
    const secret = await kv.get(keyFor(userId, service));
    if (secret !== null) services.push({ service, key: keyFor(userId, service), secret });
  }
  return services;
}

export async function getSecret(
  kv: KVNamespace,
  userId: number,
  service: string,
): Promise<string | null> {
  return kv.get(keyFor(userId, service));
}

export async function saveSecret(
  kv: KVNamespace,
  userId: number,
  service: string,
  secret: string,
): Promise<void> {
  await kv.put(keyFor(userId, service), secret);
}

export async function removeSecret(
  kv: KVNamespace,
  userId: number,
  service: string,
): Promise<void> {
  await kv.delete(keyFor(userId, service));
}

export async function removeAll(kv: KVNamespace, userId: number): Promise<void> {
  const keys = await listServiceNames(kv, userId);
  await Promise.all(keys.map((service) => kv.delete(keyFor(userId, service))));
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
