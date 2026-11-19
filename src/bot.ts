import type { Env, TelegramCallbackQuery, TelegramMessage, TelegramUpdate } from './types';
import {
  LIST_CLEANUP_DELAY_SECONDS,
  isListCommand,
  isStartCommand,
  scheduleCleanup,
} from './cleanup';
import {
  answerCallbackQuery,
  deleteMessage,
  downloadDocument,
  editMenu,
  escapeHtml,
  sendDocument,
  sendMenu,
  sendText,
  type InlineKeyboardButton,
  type InlineKeyboardMarkup,
} from './telegram';
import * as store from './store';
import { generateTOTP, normalizeSecret, secondsRemaining } from './totp';

/**
 * Whitelist statis (opsional). Lebih disarankan memakai environment variable
 * ALLOWED_USERS di wrangler.toml. Jika keduanya kosong, semua user ditolak.
 */
const ALLOWED_USERS: number[] = [
  // 123456789, // contoh
];

const MAX_SERVICES = 200;
const SERVICE_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const BACKUP_FORMAT = 'totp-backup-v1';
/** Telegram membatasi jumlah tombol inline; sisanya tetap bisa lewat /code. */
const MAX_LIST_BUTTONS = 40;

interface ParsedService {
  service: string;
  secret: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAllowed(userId: number, env: Env): boolean {
  const fromEnv = (env.ALLOWED_USERS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const allowed = new Set<string>([...fromEnv, ...ALLOWED_USERS.map(String)]);
  return allowed.has(String(userId));
}

function normalizeService(input: string): string | null {
  const service = input.trim().toLowerCase();
  return SERVICE_PATTERN.test(service) ? service : null;
}

// ---------------------------------------------------------------------------
// Teks menu (tanpa parse_mode HTML; navigasi memakai inline keyboard)
// ---------------------------------------------------------------------------

function usageAdd(): string {
  return [
    'Format: /add <service> <secret>',
    'Contoh: /add github JBSWY3DPEHPK3PXP',
    'Boleh juga menempel URL otpauth://...',
  ].join('\n');
}

function usageImport(): string {
  return [
    'Cara pakai /import:',
    '1) Kirim file JSON hasil /export ke chat ini, atau',
    '2) /import <tempel JSON di sini>',
    '',
    'Format didukung: backup bot ini, Proton Authenticator, Google',
    'Authenticator, Aegis, array [{service, secret}], atau object polos.',
    '',
    'Tambahkan kata replace untuk menimpa seluruh data lama:',
    '/import replace { ...json... }',
    'Tanpa "replace", data digabung (merge).',
  ].join('\n');
}

function helpText(): string {
  return [
    '🤖 Telegram TOTP Authenticator',
    '',
    'Pilih menu lewat tombol di bawah.',
    '',
    'Perintah cepat:',
    '/start · /help · /add <service> <secret> · /code <service>',
    '/list · /delete <service> · /export · /import',
  ].join('\n');
}

function addPromptText(): string {
  return [
    '➕ Tambah layanan',
    '',
    'Kirim pesan dengan format:',
    '<service> <secret>',
    '',
    'Contoh: github JBSWY3DPEHPK3PXP',
    'Boleh juga URL otpauth://...',
  ].join('\n');
}

function importPromptText(replace: boolean): string {
  return [
    replace ? '📥 Import (Replace)' : '📥 Import (Merge)',
    '',
    replace
      ? 'Kirim JSON backup. Semua data lama akan ditimpa.'
      : 'Kirim JSON backup. Data lama tetap digabung.',
    '',
    'Boleh juga kirim file .json.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Keyboard / tombol
// ---------------------------------------------------------------------------

const CLOSE_BUTTON: InlineKeyboardButton = { text: '❌ Close', callback_data: 'x:close' };

/** Footer dengan target Back yang bisa disesuaikan (kembali ke layar sebelumnya). */
function backKeyboard(back: string): InlineKeyboardMarkup {
  return { inline_keyboard: [[{ text: '⬅️ Back', callback_data: back }, CLOSE_BUTTON]] };
}

/** Default: Back ke menu utama. */
function footerKeyboard(): InlineKeyboardMarkup {
  return backKeyboard('m:main');
}

/** Teks OTP memakai tag <code> agar bisa langsung disalin di Telegram. */
function otpText(service: string, code: string, remaining: number): string {
  return [
    `🔑 <b>Kode TOTP untuk ${escapeHtml(service)}</b>`,
    '',
    `<code>${code}</code>`,
    '',
    `Berlaku ±${remaining} detik lagi.`,
  ].join('\n');
}

/** Menu utama. Tombol Hapus hanya ada di sini (menu /help). */
function mainMenuKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: '📋 Daftar Layanan', callback_data: 'm:list' }],
      [
        { text: '🔑 Kode OTP', callback_data: 'm:code' },
        { text: '➕ Tambah', callback_data: 'm:add' },
      ],
      [
        { text: '🗑️ Hapus', callback_data: 'm:delete' },
        { text: '📤 Export', callback_data: 'm:export' },
      ],
      [
        { text: '📥 Import', callback_data: 'm:import' },
        { text: '📥 Import (Replace)', callback_data: 'm:import_replace' },
      ],
      [CLOSE_BUTTON],
    ],
  };
}

/** Tombol per layanan. Angka pada callback_data adalah index dari daftar terurut. */
function serviceKeyboard(services: string[], scope: 'l' | 'k' | 'd'): InlineKeyboardMarkup {
  const shown = services.slice(0, MAX_LIST_BUTTONS);
  const rows: InlineKeyboardButton[][] = [];
  for (let i = 0; i < shown.length; i += 2) {
    const row: InlineKeyboardButton[] = [];
    for (let j = i; j < Math.min(i + 2, shown.length); j++) {
      row.push({
        text: `• ${shown[j]}`,
        callback_data: scope === 'd' ? `d:${j}` : `c:${scope}:${j}`,
      });
    }
    rows.push(row);
  }
  rows.push([{ text: '⬅️ Back', callback_data: 'm:main' }, CLOSE_BUTTON]);
  return { inline_keyboard: rows };
}

function serviceListText(title: string, services: string[], hint: string): string {
  const shown = services.slice(0, MAX_LIST_BUTTONS);
  const lines = shown.map((service, index) => `${index + 1}. ${service}`);
  let text = `${title} (${services.length}):\n\n${lines.join('\n')}`;
  if (services.length > MAX_LIST_BUTTONS) {
    text += `\n\n…dan ${services.length - MAX_LIST_BUTTONS} layanan lainnya (pakai /code <service>).`;
  }
  return `${text}\n\n${hint}`;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Entry point untuk satu update dari Telegram. */
export async function handleUpdate(update: TelegramUpdate, env: Env): Promise<void> {
  if (update.callback_query) {
    await handleCallback(update.callback_query, env);
    return;
  }

  const message = update.message ?? update.edited_message;
  if (!message?.from || !message.chat) return;

  const userId = message.from.id;
  const chatId = message.chat.id;
  const text = message.text;

  // /start sengaja dipertahankan. /list dipertahankan 60 detik, lainnya 30 detik.
  if (!isStartCommand(text)) {
    const delay = isListCommand(text) ? LIST_CLEANUP_DELAY_SECONDS : undefined;
    await scheduleCleanup(env, chatId, [message.message_id], delay);
  }

  if (!isAllowed(userId, env)) {
    try {
      await sendText(env, chatId, 'Unauthorized.');
    } catch (error) {
      console.error('[bot] gagal membalas user tidak diizinkan:', error);
    }
    return;
  }

  try {
    if (message.document) {
      await handleDocument(message, env, userId, chatId);
      return;
    }
    if (!text) return;
    await handleText(text.trim(), env, userId, chatId);
  } catch (error) {
    console.error('[bot] error saat memproses pesan:', error);
    try {
      await sendText(env, chatId, `⚠️ Terjadi kesalahan: ${errorMessage(error)}`);
    } catch (replyError) {
      console.error('[bot] gagal mengirim pesan error:', replyError);
    }
  }
}

async function handleText(text: string, env: Env, userId: number, chatId: number): Promise<void> {
  // Teks biasa bisa merupakan jawaban alur tombol (Tambah / Import).
  if (!text.startsWith('/')) {
    const pending = await store.getPendingAction(env.AUTH_KV, chatId);
    if (pending) {
      await store.clearPendingAction(env.AUTH_KV, chatId);
      if (pending.type === 'add') {
        await handleAdd(text, env, userId, chatId);
      } else {
        await importBackup(text, env, userId, chatId, pending.replace);
      }
      return;
    }
    // Teks JSON langsung juga diterima sebagai import (tanpa perintah).
    if (text.startsWith('{') || text.startsWith('[')) {
      await importBackup(text, env, userId, chatId, false);
    }
    return;
  }

  // Perintah apa pun membatalkan alur tombol yang sedang menunggu input.
  await store.clearPendingAction(env.AUTH_KV, chatId);

  const head = text.split(/\s+/, 1)[0];
  const rest = text.slice(head.length).trim();
  const command = head.replace(/@.*$/, '').toLowerCase();

  switch (command) {
    case '/start':
      // Pengecualian: pesan /start dan balasannya tidak dihapus.
      await sendMenu(env, chatId, helpText(), mainMenuKeyboard(), false);
      break;

    case '/help':
      await sendMenu(env, chatId, helpText(), mainMenuKeyboard());
      break;

    case '/add':
      await handleAdd(rest, env, userId, chatId);
      break;

    case '/code':
      await handleCode(rest, env, userId, chatId);
      break;

    case '/list':
      await handleList(env, userId, chatId);
      break;

    case '/delete':
      await handleDelete(rest, env, userId, chatId);
      break;

    case '/export':
      await handleExport(env, userId, chatId);
      break;

    case '/import': {
      // Hanya kata "replace" di awal argumen yang dianggap flag, bukan kata di dalam JSON.
      const replace = /^replace(?:\s|$)/i.test(rest);
      const payload = replace ? rest.replace(/^replace(?:\s+|$)/i, '').trim() : rest;
      if (!payload) {
        await sendMenu(env, chatId, usageImport(), footerKeyboard());
        break;
      }
      await importBackup(payload, env, userId, chatId, replace);
      break;
    }

    default:
      await sendMenu(
        env,
        chatId,
        `Perintah tidak dikenal: ${command}\n\n${helpText()}`,
        mainMenuKeyboard(),
      );
  }
}

// ---------------------------------------------------------------------------
// Aksi perintah
// ---------------------------------------------------------------------------

async function handleAdd(args: string, env: Env, userId: number, chatId: number): Promise<void> {
  const [rawService, rawSecret] = args.split(/\s+/);
  const service = normalizeService(rawService ?? '');
  if (!service || !rawSecret) {
    await sendMenu(env, chatId, usageAdd(), footerKeyboard());
    return;
  }

  let secret: string;
  try {
    secret = normalizeSecret(rawSecret);
  } catch (error) {
    await sendMenu(env, chatId, `⛔ Secret ditolak: ${errorMessage(error)}`, footerKeyboard());
    return;
  }

  const existing = await store.listServiceNames(env.AUTH_KV, userId);
  if (!existing.includes(service) && existing.length >= MAX_SERVICES) {
    await sendMenu(
      env,
      chatId,
      `Batas ${MAX_SERVICES} layanan tercapai. Hapus sebagian sebelum menambah.`,
      footerKeyboard(),
    );
    return;
  }

  const wasExisting = existing.includes(service);
  await store.saveSecret(env, userId, service, secret);
  await sendMenu(
    env,
    chatId,
    `✅ Secret untuk ${service} berhasil ${wasExisting ? 'diperbarui' : 'disimpan'}.\nGunakan /code ${service} untuk melihat OTP.`,
    footerKeyboard(),
  );
}

/**
 * Tampilkan OTP. Bila `editMessageId` diberikan, pesan yang sama yang diubah
 * (dipakai tombol); jika tidak, kirim pesan baru (dipakai perintah /code).
 */
async function showCode(
  env: Env,
  userId: number,
  chatId: number,
  service: string,
  back: string,
  editMessageId?: number,
): Promise<void> {
  const secret = await store.getSecret(env, userId, service);
  if (secret === null) {
    const text = `Layanan ${service} belum terdaftar. Cek /list.`;
    if (editMessageId !== undefined) {
      await editMenu(env, chatId, editMessageId, text, backKeyboard(back));
    } else {
      await sendMenu(env, chatId, text, footerKeyboard());
    }
    return;
  }

  const code = await generateTOTP(secret);
  const text = otpText(service, code, secondsRemaining());
  if (editMessageId !== undefined) {
    await editMenu(env, chatId, editMessageId, text, backKeyboard(back), 'HTML');
  } else {
    await sendMenu(env, chatId, text, footerKeyboard(), true, undefined, 'HTML');
  }
}

async function handleCode(args: string, env: Env, userId: number, chatId: number): Promise<void> {
  const service = normalizeService(args.split(/\s+/)[0] ?? '');
  if (!service) {
    await sendMenu(env, chatId, 'Format: /code <service>\nContoh: /code github', footerKeyboard());
    return;
  }
  await showCode(env, userId, chatId, service, 'm:main');
}

async function listContent(
  env: Env,
  userId: number,
): Promise<{ text: string; keyboard: InlineKeyboardMarkup }> {
  const services = await store.listServiceNames(env.AUTH_KV, userId);
  if (services.length === 0) {
    return {
      text: 'Belum ada layanan tersimpan. Tambahkan lewat menu Tambah.',
      keyboard: footerKeyboard(),
    };
  }
  return {
    text: serviceListText('📋 Daftar Layanan', services, 'Pilih layanan untuk melihat kode OTP-nya.'),
    keyboard: serviceKeyboard(services, 'l'),
  };
}

/** Kirim pesan daftar layanan baru lewat perintah /list (jeda hapus 60 detik). */
async function sendListMenu(env: Env, userId: number, chatId: number): Promise<void> {
  const { text, keyboard } = await listContent(env, userId);
  await sendMenu(env, chatId, text, keyboard, true, LIST_CLEANUP_DELAY_SECONDS);
}

/** Ubah pesan yang sedang aktif menjadi daftar layanan (dipakai tombol). */
async function editListMenu(
  env: Env,
  chatId: number,
  messageId: number,
  userId: number,
): Promise<void> {
  const { text, keyboard } = await listContent(env, userId);
  await editMenu(env, chatId, messageId, text, keyboard);
}

async function handleList(env: Env, userId: number, chatId: number): Promise<void> {
  await sendListMenu(env, userId, chatId);
}

async function handleDelete(args: string, env: Env, userId: number, chatId: number): Promise<void> {
  const service = normalizeService(args.split(/\s+/)[0] ?? '');
  if (!service) {
    await sendMenu(
      env,
      chatId,
      'Format: /delete <service>\nContoh: /delete github',
      footerKeyboard(),
    );
    return;
  }

  const secret = await store.getSecret(env, userId, service);
  if (secret === null) {
    await sendMenu(env, chatId, `Layanan ${service} tidak ditemukan.`, footerKeyboard());
    return;
  }

  await store.removeSecret(env, userId, service);
  await sendMenu(env, chatId, `✅ Layanan ${service} dihapus.`, footerKeyboard());
}

async function handleExport(env: Env, userId: number, chatId: number): Promise<void> {
  const services = await store.listServices(env, userId);
  if (services.length === 0) {
    await sendMenu(
      env,
      chatId,
      'Belum ada data untuk diekspor. Tambahkan secret lewat menu Tambah.',
      footerKeyboard(),
    );
    return;
  }

  const backup = {
    format: BACKUP_FORMAT,
    exported_at: new Date().toISOString(),
    user_id: userId,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    count: services.length,
    services: Object.fromEntries(services.map((item) => [item.service, item.secret])),
  };
  const json = JSON.stringify(backup, null, 2);
  const filename = `totp-backup-${userId}-${new Date().toISOString().slice(0, 10)}.json`;

  const sent = await sendDocument(
    env,
    chatId,
    filename,
    json,
    `${services.length} secret. Jangan bagikan file ini.`,
    footerKeyboard(),
  );

  if (sent === null) {
    // Fallback bila pengiriman dokumen gagal.
    await sendText(env, chatId, `Gagal mengirim file. Berikut isi backup-nya:\n\n${json}`);
  }
}

async function handleDocument(
  message: TelegramMessage,
  env: Env,
  userId: number,
  chatId: number,
): Promise<void> {
  if (!message.document) return;
  const caption = message.document.caption ?? '';
  const replace = /(^|\s)replace(\s|$)/i.test(caption);

  const contents = await downloadDocument(env, message.document.file_id);
  await importBackup(contents, env, userId, chatId, replace);
}

// ---------------------------------------------------------------------------
// Callback inline keyboard
// ---------------------------------------------------------------------------

async function handleCallback(callback: TelegramCallbackQuery, env: Env): Promise<void> {
  const userId = callback.from.id;
  const chatId = callback.message?.chat.id;
  const messageId = callback.message?.message_id;
  const data = callback.data ?? '';

  // Balas dulu supaya tombol tidak stuck "loading".
  await answerCallbackQuery(env, callback.id);

  if (!isAllowed(userId, env)) return;
  if (!chatId || !messageId) return;

  try {
    if (data === 'x:close') {
      await store.clearPendingAction(env.AUTH_KV, chatId);
      await deleteMessage(env, chatId, messageId);
      return;
    }

    if (data === 'm:main') {
      await store.clearPendingAction(env.AUTH_KV, chatId);
      await editMenu(env, chatId, messageId, helpText(), mainMenuKeyboard());
      return;
    }

    // m:* = buka dari menu utama, b:* = tombol Back dari layar sebelumnya.
    // Semuanya mengubah pesan yang sama (edit), tidak menambah pesan baru.
    if (data === 'm:list' || data === 'b:list') {
      await store.clearPendingAction(env.AUTH_KV, chatId);
      await editListMenu(env, chatId, messageId, userId);
      return;
    }

    if (data === 'm:code' || data === 'b:code' || data === 'm:delete' || data === 'b:delete') {
      await store.clearPendingAction(env.AUTH_KV, chatId);
      const kind = data.endsWith('code') ? 'code' : 'delete';
      await showPicker(env, chatId, messageId, userId, kind);
      return;
    }

    if (data === 'm:add') {
      await store.setPendingAction(env.AUTH_KV, chatId, { type: 'add' });
      await editMenu(env, chatId, messageId, addPromptText(), footerKeyboard());
      return;
    }

    if (data === 'm:import' || data === 'm:import_replace') {
      const replace = data === 'm:import_replace';
      await store.setPendingAction(env.AUTH_KV, chatId, { type: 'import', replace });
      await editMenu(env, chatId, messageId, importPromptText(replace), footerKeyboard());
      return;
    }

    if (data === 'm:export') {
      await store.clearPendingAction(env.AUTH_KV, chatId);
      await editMenu(env, chatId, messageId, '📤 Backup JSON dikirim.', footerKeyboard());
      await handleExport(env, userId, chatId);
      return;
    }

    // c:l:<index> / c:k:<index> — lihat kode OTP dari daftar / list.
    // Back dari OTP kembali ke layar asalnya (list atau picker kode).
    const codeMatch = data.match(/^c:(l|k):(\d+)$/);
    if (codeMatch) {
      const service = await serviceAt(env, userId, Number(codeMatch[2]));
      if (service) {
        await showCode(
          env,
          userId,
          chatId,
          service,
          codeMatch[1] === 'l' ? 'b:list' : 'b:code',
          messageId,
        );
      }
      return;
    }

    // d:<index> — konfirmasi hapus.
    const deleteMatch = data.match(/^d:(\d+)$/);
    if (deleteMatch) {
      const index = deleteMatch[1];
      const service = await serviceAt(env, userId, Number(index));
      if (!service) return;
      await editMenu(
        env,
        chatId,
        messageId,
        `Yakin hapus layanan ${service}?`,
        {
          inline_keyboard: [
            [{ text: '✅ Ya, hapus', callback_data: `dy:${index}` }],
            [{ text: '↩️ Batal', callback_data: 'b:delete' }],
            [{ text: '⬅️ Back', callback_data: 'm:main' }, CLOSE_BUTTON],
          ],
        },
      );
      return;
    }

    // dy:<index> — eksekusi hapus setelah konfirmasi.
    const deleteYesMatch = data.match(/^dy:(\d+)$/);
    if (deleteYesMatch) {
      const service = await serviceAt(env, userId, Number(deleteYesMatch[1]));
      if (!service) return;
      await store.removeSecret(env, userId, service);
      await editMenu(
        env,
        chatId,
        messageId,
        `✅ Layanan ${service} dihapus.`,
        backKeyboard('b:delete'),
      );
    }
  } catch (error) {
    console.error('[bot] error saat memproses callback:', error);
  }
}

async function serviceAt(env: Env, userId: number, index: number): Promise<string | null> {
  if (!Number.isInteger(index) || index < 0 || index >= MAX_LIST_BUTTONS) return null;
  const services = await store.listServiceNames(env.AUTH_KV, userId);
  return services[index] ?? null;
}

async function showPicker(
  env: Env,
  chatId: number,
  messageId: number,
  userId: number,
  kind: 'code' | 'delete',
): Promise<void> {
  const services = await store.listServiceNames(env.AUTH_KV, userId);
  if (services.length === 0) {
    await editMenu(
      env,
      chatId,
      messageId,
      'Belum ada layanan tersimpan. Tambahkan lewat menu Tambah.',
      footerKeyboard(),
    );
    return;
  }

  const title = kind === 'code' ? '🔑 Pilih layanan (kode OTP)' : '🗑️ Pilih layanan (hapus)';
  const hint =
    kind === 'code'
      ? 'Pilih layanan untuk melihat kode OTP-nya.'
      : 'Pilih layanan untuk menghapusnya.';
  await editMenu(
    env,
    chatId,
    messageId,
    serviceListText(title, services, hint),
    serviceKeyboard(services, kind === 'code' ? 'k' : 'd'),
  );
}

// ---------------------------------------------------------------------------
// Backup: parsing & import
// ---------------------------------------------------------------------------

/** Pasangan nama/secret mentah hasil ekstraksi dari JSON backup. */
interface RawEntry {
  name: string;
  secret: string;
}

const NAME_KEYS = ['service', 'name', 'issuer', 'label', 'title', 'account', 'username'];
const SECRET_KEYS = ['secret', 'secret_key', 'secretKey', 'key', 'value', 'token'];
const URI_KEYS = ['uri', 'url', 'otpauth', 'otpauth_url', 'provisioning_uri', 'link'];
const CONTAINER_KEYS = [
  'services',
  'secrets',
  'entries',
  'items',
  'accounts',
  'credentials',
  'data',
  'totp',
  'backup',
  'content',
];
const METADATA_KEYS = new Set([
  'format',
  'version',
  'exported_at',
  'created_at',
  'updated_at',
  'timestamp',
  'user_id',
  'count',
  'algorithm',
  'digits',
  'period',
  'type',
  'entry_type',
  'id',
  'note',
]);

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * Nama dari aplikasi authenticator bisa berisi spasi, '@', dll., sedangkan
 * kunci KV hanya boleh [a-z0-9][a-z0-9_.-]{0,63}. Ubah ke slug bila perlu.
 */
function toServiceName(raw: string): string | null {
  const direct = normalizeService(raw);
  if (direct) return direct;

  const slug = raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 64)
    .replace(/[._-]+$/g, '');

  return normalizeService(slug);
}

/** Ambil secret + nama dari URL otpauth:// (format ekspor Proton, Google, dll.). */
function fromOtpauthUri(uri: string, fallbackName?: string): RawEntry | null {
  let url: URL;
  try {
    url = new URL(uri.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'otpauth:') return null;

  const secret = url.searchParams.get('secret');
  if (!secret) return null;

  // pathname = "/totp/<label>" untuk skema otpauth:// (host = "totp").
  const path = url.pathname.replace(/^\/+/, '');
  const labelRaw = path.includes('/') ? path.slice(path.indexOf('/') + 1) : path;
  let label = labelRaw;
  try {
    label = decodeURIComponent(labelRaw);
  } catch {
    // biarkan label apa adanya
  }
  // Label otpauth umumnya "issuer:account"; pakai bagian account.
  const account = label.includes(':') ? label.slice(label.indexOf(':') + 1) : label;
  const name = fallbackName || account || url.searchParams.get('issuer') || '';
  if (!name) return null;
  return { name, secret };
}

/**
 * Kumpulkan pasangan nama/secret dari struktur JSON apa pun.
 * Mendukung backup bot sendiri, Proton Authenticator (`entries[].content.uri`),
 * Google Authenticator (`services[].secret`), Aegis, array objek, dan object
 * polos `{ "nama": "SECRET" }`.
 */
function collectEntries(
  node: unknown,
  out: RawEntry[],
  nameHint: string | undefined,
  depth: number,
): void {
  if (depth > 10) return;

  if (typeof node === 'string') {
    if (/^otpauth:\/\//i.test(node.trim())) {
      const parsed = fromOtpauthUri(node, nameHint);
      if (parsed) out.push(parsed);
    }
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectEntries(item, out, nameHint, depth + 1);
    return;
  }
  if (!node || typeof node !== 'object') return;

  const record = node as Record<string, unknown>;

  // Proton Authenticator: { content: { uri: "otpauth://...", name: "..." } }
  const uri = firstString(record, URI_KEYS);
  if (uri && /^otpauth:\/\//i.test(uri)) {
    const parsed = fromOtpauthUri(uri, firstString(record, NAME_KEYS) ?? nameHint);
    if (parsed) out.push(parsed);
    return;
  }

  // Google Authenticator / Aegis / array objek: { secret: "...", name: "..." }
  const secret = firstString(record, SECRET_KEYS);
  if (secret) {
    const name = firstString(record, NAME_KEYS) ?? nameHint;
    if (name) {
      out.push({ name, secret });
      return;
    }
  }

  // Turun ke kontainer yang dikenal.
  let descended = false;
  for (const key of CONTAINER_KEYS) {
    const value = record[key];
    if (value !== null && typeof value === 'object') {
      descended = true;
      collectEntries(value, out, undefined, depth + 1);
    }
  }
  if (descended) return;

  // Object polos: { "github": "SECRET" } atau { "github": { "secret": "..." } }
  for (const [key, value] of Object.entries(record)) {
    if (METADATA_KEYS.has(key)) continue;
    if (typeof value === 'string') out.push({ name: key, secret: value });
    else if (value && typeof value === 'object') collectEntries(value, out, key, depth + 1);
  }
}

/** Parse backup JSON dari berbagai aplikasi authenticator. */
export function parseBackup(text: string): ParsedService[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('JSON tidak valid. Kirim file hasil /export atau JSON yang benar.');
  }

  const rawEntries: RawEntry[] = [];
  collectEntries(data, rawEntries, undefined, 0);

  const result: ParsedService[] = [];
  const seen = new Set<string>();

  for (const raw of rawEntries) {
    const service = toServiceName(raw.name);
    if (!service || seen.has(service)) continue;

    let secret: string;
    try {
      secret = normalizeSecret(raw.secret);
    } catch {
      continue; // lewati entri yang secret-nya invalid
    }

    seen.add(service);
    result.push({ service, secret });
  }

  return result;
}

async function importBackup(
  text: string,
  env: Env,
  userId: number,
  chatId: number,
  replace: boolean,
): Promise<void> {
  const services = parseBackup(text);
  if (services.length === 0) {
    throw new Error('Tidak ada layanan valid yang bisa di-import. Periksa format JSON Anda.');
  }

  const existing = await store.listServiceNames(env.AUTH_KV, userId);
  const union = new Set<string>([...(replace ? [] : existing), ...services.map((item) => item.service)]);
  if (union.size > MAX_SERVICES) {
    throw new Error(`Import melebihi batas ${MAX_SERVICES} layanan per user.`);
  }

  if (replace && existing.length > 0) {
    await store.removeAll(env, userId);
  }

  await Promise.all(
    services.map((item) => store.saveSecret(env, userId, item.service, item.secret)),
  );

  await sendMenu(
    env,
    chatId,
    `✅ Import selesai (mode ${replace ? 'replace' : 'merge'}): ${services.length} layanan tersimpan.\nCek dengan /list.`,
    footerKeyboard(),
  );
}
