import { scheduleCleanup } from './cleanup';
import type { Env } from './types';

const TELEGRAM_API = 'https://api.telegram.org';

export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

function apiUrl(env: Env, method: string): string {
  return `${TELEGRAM_API}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
}

/** Potong teks agar tidak melebihi batas 4096 karakter per pesan Telegram. */
function splitText(text: string, max = 3800): string[] {
  if (text.length <= max) return [text];

  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** Escape karakter khusus untuk parse_mode HTML Telegram. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function sendMessage(
  env: Env,
  chatId: number,
  text: string,
  parseMode: 'HTML' | undefined,
  autoDelete: boolean,
  replyMarkup?: InlineKeyboardMarkup,
  delaySeconds?: number,
): Promise<number[]> {
  const sentIds: number[] = [];
  for (const chunk of splitText(text)) {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text: chunk,
      disable_web_page_preview: true,
    };
    if (parseMode) body.parse_mode = parseMode;
    if (replyMarkup) body.reply_markup = replyMarkup;

    const response = await fetch(apiUrl(env, 'sendMessage'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      console.error('[telegram] sendMessage gagal:', response.status, await response.text());
      continue;
    }
    const data = (await response.json()) as { result?: { message_id?: number } };
    if (data.result?.message_id) sentIds.push(data.result.message_id);
  }
  if (autoDelete) await scheduleCleanup(env, chatId, sentIds, delaySeconds);
  return sentIds;
}

/** Kirim teks biasa (tanpa parse_mode). */
export function sendText(
  env: Env,
  chatId: number,
  text: string,
  autoDelete = true,
  delaySeconds?: number,
): Promise<number[]> {
  return sendMessage(env, chatId, text, undefined, autoDelete, undefined, delaySeconds);
}

/**
 * Kirim teks dengan parse_mode HTML Telegram.
 * Tag harus seimbang di setiap baris agar aman saat pesan dipecah splitText().
 */
export function sendHtml(
  env: Env,
  chatId: number,
  html: string,
  autoDelete = true,
  delaySeconds?: number,
): Promise<number[]> {
  return sendMessage(env, chatId, html, 'HTML', autoDelete, undefined, delaySeconds);
}

/** Kirim pesan menu baru lengkap dengan tombol inline keyboard. */
export function sendMenu(
  env: Env,
  chatId: number,
  text: string,
  keyboard: InlineKeyboardMarkup,
  autoDelete = true,
  delaySeconds?: number,
  parseMode?: 'HTML',
): Promise<number[]> {
  return sendMessage(env, chatId, text, parseMode, autoDelete, keyboard, delaySeconds);
}

/**
 * Ganti isi + tombol pesan menu yang sudah ada (navigasi back/sub-menu).
 * Semua tombol memakai ini agar hanya satu pesan yang berubah, bukan menumpuk.
 */
export async function editMenu(
  env: Env,
  chatId: number,
  messageId: number,
  text: string,
  keyboard: InlineKeyboardMarkup,
  parseMode?: 'HTML',
): Promise<boolean> {
  // Selalu kirim parse_mode supaya entitas lama (mis. <code> dari OTP) tidak
  // ikut terbawa saat pesan yang sama diedit menjadi menu biasa.
  const body: Record<string, unknown> = {
    chat_id: chatId,
    message_id: messageId,
    text: (parseMode === 'HTML' ? text : escapeHtml(text)).slice(0, 4096),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: keyboard,
  };

  const response = await fetch(apiUrl(env, 'editMessageText'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (response.ok) return true;

  const detail = await response.text();
  // Edit ke isi yang sama bukan error bagi kita.
  if (detail.includes('message is not modified')) return true;
  console.error('[telegram] editMessageText gagal:', response.status, detail);
  return false;
}

/** Hentikan spinner "loading" pada tombol yang ditekan. */
export async function answerCallbackQuery(
  env: Env,
  callbackQueryId: string,
  text?: string,
): Promise<void> {
  try {
    const body: Record<string, unknown> = { callback_query_id: callbackQueryId };
    if (text) body.text = text.slice(0, 200);
    await fetch(apiUrl(env, 'answerCallbackQuery'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (error) {
    console.error('[telegram] answerCallbackQuery gagal:', error);
  }
}

/** Hapus satu pesan (dipakai tombol Close). */
export async function deleteMessage(env: Env, chatId: number, messageId: number): Promise<void> {
  try {
    await deleteMessages(env, chatId, [messageId]);
  } catch (error) {
    console.error('[telegram] deleteMessage gagal:', error);
  }
}

/** Kirim backup JSON sebagai dokumen (dokumen Telegram, bukan teks biasa). */
export async function sendDocument(
  env: Env,
  chatId: number,
  filename: string,
  contents: string,
  caption?: string,
  replyMarkup?: InlineKeyboardMarkup,
  delaySeconds?: number,
): Promise<number | null> {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('document', new Blob([contents], { type: 'application/json;charset=utf-8' }), filename);
  if (caption) form.append('caption', caption.slice(0, 1000));
  if (replyMarkup) form.append('reply_markup', JSON.stringify(replyMarkup));

  const response = await fetch(apiUrl(env, 'sendDocument'), {
    method: 'POST',
    body: form,
  });

  if (!response.ok) {
    console.error('[telegram] sendDocument gagal:', response.status, await response.text());
    return null;
  }

  const data = (await response.json()) as { result?: { message_id?: number } };
  const messageId = data.result?.message_id ?? null;
  if (messageId !== null) await scheduleCleanup(env, chatId, [messageId], delaySeconds);
  return messageId;
}

/** Unduh isi dokumen yang dikirim user (maks. 1 MiB) sebagai teks. */
export async function downloadDocument(
  env: Env,
  fileId: string,
  maxBytes = 1024 * 1024,
): Promise<string> {
  const infoResponse = await fetch(apiUrl(env, 'getFile'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ file_id: fileId }),
  });
  if (!infoResponse.ok) throw new Error('Gagal meminta informasi file ke Telegram.');

  const info = (await infoResponse.json()) as {
    ok?: boolean;
    result?: { file_path?: string; file_size?: number };
  };
  const filePath = info.result?.file_path;
  if (!filePath) throw new Error('File tidak ditemukan di Telegram.');
  if ((info.result?.file_size ?? 0) > maxBytes) {
    throw new Error('File terlalu besar. Maksimal 1 MiB.');
  }

  const fileResponse = await fetch(`${TELEGRAM_API}/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`);
  if (!fileResponse.ok) throw new Error('Gagal mengunduh file dari Telegram.');

  const text = await fileResponse.text();
  if (new TextEncoder().encode(text).length > maxBytes) {
    throw new Error('Isi file terlalu besar. Maksimal 1 MiB.');
  }
  return text;
}

/**
 * Hapus pesan yang sudah lewat masa jeda. Error 4xx (mis. pesan sudah dihapus
 * manual) dianggap non-fatal agar antrean tidak retry tanpa henti; 5xx/network
 * dilempar agar Queue melakukan retry.
 */
export async function deleteMessages(
  env: Env,
  chatId: number,
  messageIds: number[],
): Promise<void> {
  for (const messageId of messageIds) {
    const response = await fetch(apiUrl(env, 'deleteMessage'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
    });
    if (response.ok) continue;

    const detail = await response.text();
    if (response.status >= 500) {
      throw new Error(`deleteMessage ${messageId} gagal (HTTP ${response.status}): ${detail}`);
    }
    console.warn('[telegram] deleteMessage dilewati:', messageId, response.status, detail);
  }
}
