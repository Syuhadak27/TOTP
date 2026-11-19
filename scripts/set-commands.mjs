/**
 * Mendaftarkan daftar perintah bot ke Telegram (setMyCommands).
 * Token dibaca dari env TELEGRAM_BOT_TOKEN atau file .dev.vars (gitignored).
 *
 * Dipakai otomatis sebagai postdeploy, atau manual:
 *   npm run commands:set
 */

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const commands = [
  { command: 'start', description: 'Mulai / tampilkan bantuan' },
  { command: 'help', description: 'Tampilkan daftar perintah' },
  { command: 'add', description: 'Simpan secret (Base32 atau otpauth://)' },
  { command: 'code', description: 'Ambil kode OTP 6 digit' },
  { command: 'list', description: 'Daftar layanan tersimpan' },
  { command: 'delete', description: 'Hapus satu layanan' },
  { command: 'export', description: 'Unduh backup JSON semua secret' },
  { command: 'import', description: 'Restore dari file / teks JSON' },
];

async function loadToken() {
  if (process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN.trim();

  try {
    const contents = await readFile(join(projectRoot, '.dev.vars'), 'utf8');
    const line = contents
      .split(/\r?\n/)
      .find((entry) => /^\s*TELEGRAM_BOT_TOKEN\s*=/.test(entry));
    const value = line?.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
    if (value) return value;
  } catch {
    // .dev.vars tidak ada — mengandalkan env saja.
  }
  return null;
}

async function callTelegram(token, method, body) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        throw new Error(data.description || `HTTP ${response.status}`);
      }
      return data.result;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((done) => setTimeout(done, 1000 * attempt));
    }
  }
  throw lastError;
}

const token = await loadToken();
if (!token) {
  console.warn('⚠️  TELEGRAM_BOT_TOKEN tidak ditemukan; lewati setMyCommands.');
  process.exit(0);
}

try {
  await callTelegram(token, 'setMyCommands', { commands });
  const active = await callTelegram(token, 'getMyCommands', {});
  console.log(`✅ ${active.length} bot command terdaftar:`);
  for (const item of active) console.log(`   /${item.command} — ${item.description}`);
} catch (error) {
  console.error('❌ Gagal mendaftarkan bot command:', error.message);
  process.exit(1);
}
