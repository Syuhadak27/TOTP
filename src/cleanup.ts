/** Penjadwalan penghapusan pesan via Cloudflare Queues (delay 30 detik). */

import type { CleanupJob, Env } from './types';

export const CLEANUP_DELAY_SECONDS = 30;
/** Daftar layanan (/list) sengaja dipertahankan lebih lama. */
export const LIST_CLEANUP_DELAY_SECONDS = 60;

/**
 * Antrean dipakai karena `ctx.waitUntil()` hanya bertahan 30 detik setelah respons
 * dan bisa dibatalkan; Queue memberi delay presisi plus retry otomatis.
 * `delaySeconds` bisa dioverride (mis. 60 detik untuk pesan /list).
 */
export async function scheduleCleanup(
  env: Env,
  chatId: number,
  messageIds: number[],
  delaySeconds: number = CLEANUP_DELAY_SECONDS,
): Promise<void> {
  const ids = Array.from(new Set(messageIds.filter((id) => Number.isInteger(id) && id > 0)));
  if (ids.length === 0) return;

  if (!env.CLEANUP_QUEUE) {
    console.warn('[cleanup] binding CLEANUP_QUEUE tidak ada; auto-delete dilewati.');
    return;
  }

  try {
    const job: CleanupJob = { chatId, messageIds: ids };
    await env.CLEANUP_QUEUE.send(job, { delaySeconds });
  } catch (error) {
    console.error('[cleanup] gagal menjadwalkan penghapusan:', error);
  }
}

function commandOf(text?: string): string {
  if (!text) return '';
  const head = text.trim().split(/\s+/, 1)[0] ?? '';
  return head.replace(/@.*$/, '').toLowerCase();
}

/** Pesan /start dikecualikan dari auto-delete beserta balasannya. */
export function isStartCommand(text?: string): boolean {
  return commandOf(text) === '/start';
}

/** Pesan /list memakai jeda hapus lebih lama (60 detik). */
export function isListCommand(text?: string): boolean {
  return commandOf(text) === '/list';
}
