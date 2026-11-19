import type { CleanupJob, Env, TelegramUpdate } from './types';
import { handleUpdate } from './bot';
import { deleteMessages } from './telegram';

/** Perbandingan string konstan-waktu untuk secret token webhook. */
function secureEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) {
    difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return difference === 0;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const webhookPath = env.WEBHOOK_PATH || '/webhook';

    if (url.pathname === webhookPath) {
      if (request.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405 });
      }

      const providedToken = request.headers.get('x-telegram-bot-api-secret-token') ?? '';
      if (!env.WEBHOOK_SECRET || !secureEqual(providedToken, env.WEBHOOK_SECRET)) {
        return new Response('Forbidden', { status: 403 });
      }

      let update: TelegramUpdate;
      try {
        update = (await request.json()) as TelegramUpdate;
      } catch {
        return new Response('Bad Request', { status: 400 });
      }

      if (!update || typeof update !== 'object') {
        return new Response('Bad Request', { status: 400 });
      }

      // Balas Telegram cepat; proses pesan di background.
      ctx.waitUntil(handleUpdate(update, env));
      return new Response('ok', { status: 200 });
    }

    if (request.method === 'GET' && url.pathname === '/') {
      return new Response(
        `Telegram TOTP Worker aktif. Webhook: POST ${webhookPath}\n`,
        { headers: { 'content-type': 'text/plain; charset=utf-8' } },
      );
    }

    return new Response('Not Found', { status: 404 });
  },

  /** Konsumen antrean: hapus pesan user + balasan bot setelah jeda 30 detik. */
  async queue(batch: MessageBatch<CleanupJob>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const { chatId, messageIds } = message.body;
      if (!Number.isFinite(chatId) || !Array.isArray(messageIds)) {
        message.ack();
        continue;
      }
      try {
        await deleteMessages(env, chatId, messageIds);
        message.ack();
      } catch (error) {
        console.error('[cleanup] gagal memproses antrean:', error);
        message.retry();
      }
    }
  },
};
