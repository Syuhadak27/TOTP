# Telegram Bot Authenticator (TOTP) di Cloudflare Worker

Bot Telegram pribadi untuk menyimpan secret TOTP dan menghasilkan kode OTP 6 digit.
Berjalan sepenuhnya di Cloudflare Workers + KV, **tanpa dependency runtime**
(HMAC-SHA1 memakai Web Crypto API bawaan Worker).

## Struktur proyek

```
.
├── wrangler.toml          # konfigurasi Worker, binding KV, queue, whitelist
├── package.json
├── tsconfig.json
├── .dev.vars.example      # contoh environment untuk local dev
├── scripts/
│   └── set-commands.mjs   # daftar bot command ke Telegram
└── src/
    ├── index.ts           # router webhook + consumer antrean cleanup
    ├── bot.ts             # parsing perintah, whitelist, import/export
    ├── cleanup.ts         # penjadwalan auto-delete (delay 30 detik)
    ├── telegram.ts        # helper Telegram API (send/delete/getFile)
    ├── crypto.ts          # enkripsi/dekripsi secret KV (AES-GCM)
    ├── store.ts           # operasi KV: user_<telegram_id>_<service>
    ├── totp.ts            # RFC 6238: Base32 decode + HMAC-SHA1 + truncation
    └── types.ts           # tipe Env, update Telegram, job antrean
```

---

## 1. Persiapan

1. Buat bot via [@BotFather](https://t.me/BotFather) dan simpan **token bot**.
2. Dapatkan Telegram ID Anda (misal lewat [@userinfobot](https://t.me/userinfobot)).
3. Install dependency:

```bash
npm install
```

## 2. Buat namespace KV

```bash
npx wrangler kv namespace create AUTH_KV
# opsional, untuk mode lokal:
npx wrangler kv namespace create AUTH_KV --preview
```

Perintah di atas mengembalikan `id` (dan `preview_id`). Masukkan ke `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "AUTH_KV"
id = "<id-dari-output>"
preview_id = "<preview-id-dari-output>"  # opsional
```

> `wrangler.toml` berisi ID KV dan `ALLOWED_USERS` jadi **sengaja tidak
> di-commit**. Salin `wrangler.toml.example` → `wrangler.toml` lalu isi sendiri
> nilai tersebut sebelum menjalankan `wrangler dev` / `wrangler deploy`.

## 3. Atur whitelist dan rahasia

Whitelist di `wrangler.toml` (boleh lebih dari satu ID, dipisah koma):

```toml
[vars]
ALLOWED_USERS = "123456789,987654321"
WEBHOOK_PATH = "/webhook"
```

Alternatif: isi array `ALLOWED_USERS` di `src/bot.ts`. Jika keduanya kosong,
**semua user ditolak** (aman secara default).

Simpan token bot dan secret webhook sebagai Worker secret (jangan ditaruh di `wrangler.toml`):

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
# tempel: 123456:ABCDEF...

npx wrangler secret put WEBHOOK_SECRET
# tempel string acak panjang, misal hasil: openssl rand -hex 32

npx wrangler secret put ENCRYPTION_KEY
# tempel base64 32 byte acak, misal:
# node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

`WEBHOOK_SECRET` akan dikirim sebagai header `X-Telegram-Bot-Api-Secret-Token`
dan diverifikasi tiap request. Request tanpa/pasangan token salah ditolak `403`.

`ENCRYPTION_KEY` dipakai untuk mengenkripsi secret sebelum disimpan ke KV.
**Simpan kunci ini di tempat aman** — tanpa kunci yang sama, secret lama tidak
bisa dibaca lagi. Kunci ini juga tidak bisa dibaca balik dari Cloudflare.

## 4. Deploy

```bash
npm run typecheck   # opsional, cek TypeScript
npm run deploy
# atau: npx wrangler deploy
```

Catat URL Worker hasil deploy, misalnya:

```
https://telegram-totp-bot.<subdomain>.workers.dev
```

## 5. Daftarkan webhook ke Telegram

Ganti `<TOKEN>`, `<WEBHOOK_SECRET>`, dan `<URL_WORKER>`:

```bash
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://<URL_WORKER>/webhook",
    "secret_token": "<WEBHOOK_SECRET>",
    "allowed_updates": ["message", "edited_message", "callback_query"],
    "drop_pending_updates": true
  }'
```

Verifikasi:

```bash
curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
```

Cek log langsung dengan:

```bash
npx wrangler tail
```

## 6. Daftarkan bot command

Menu perintah Telegram (tombol `/`) didaftarkan otomatis setelah `npm run deploy`
melalui `scripts/set-commands.mjs`. Untuk mendaftarkan ulang tanpa deploy:

```bash
npm run commands:set
```

Token dibaca dari environment `TELEGRAM_BOT_TOKEN` atau dari `.dev.vars`.
Ubah daftar/deskripsi perintah di array `commands` pada `scripts/set-commands.mjs`.

---

## Cara pakai

Kirim perintah ke bot di Telegram (hanya ID yang terdaftar di `ALLOWED_USERS` yang dibalas):

| Perintah | Fungsi |
|---|---|
| `/start`, `/help` | Bantuan |
| `/add <service> <secret>` | Simpan secret Base32 (atau URL `otpauth://`) |
| `/code <service>` | Kode OTP 6 digit saat ini + sisa waktu |
| `/list` | Daftar layanan tersimpan |
| `/delete <service>` | Hapus satu layanan |
| `/export` | Kirim file JSON backup berisi semua secret Anda |
| `/import` | Restore dari file JSON atau teks JSON |

Balasan bot memakai **inline keyboard (tombol)**, bukan lagi teks/parse HTML.
`/start` dan `/help` menampilkan menu utama (Daftar, Kode, Tambah, Hapus,
Export, Import, Close). Tombol **Hapus hanya ada di menu utama**. Setiap
sub-menu punya tombol **Back** dan **Close**. Tombol "Tambah"/"Import" meminta
Anda mengirim teks/JSON berikutnya; perintah slash di atas tetap berfungsi.

Contoh:

```
/add github JBSWY3DPEHPK3PXP
/code github
/list
/delete github
```

Nama layanan dibuat lowercase dan hanya boleh berisi huruf, angka, `_`, `.`, `-`
(maks. 64 karakter). Kunci KV yang dihasilkan: `user_123456789_github`.

Secret juga bisa ditempel langsung dari URI:

```
/add github otpauth://totp/GitHub:user?secret=JBSWY3DPEHPK3PXP&issuer=GitHub
```

### Export & Import (backup / restore)

`/export` mengirim dokumen JSON seperti ini:

```json
{
  "format": "totp-backup-v1",
  "exported_at": "2026-11-19T10:00:00.000Z",
  "user_id": 123456789,
  "algorithm": "SHA1",
  "digits": 6,
  "period": 30,
  "count": 2,
  "services": {
    "github": "JBSWY3DPEHPK3PXP",
    "gitlab": "GEZDGNBVGY3TQOJQ"
  }
}
```

Restore bisa dengan salah satu cara:

1. Kirim file `.json` tersebut ke bot (tanpa perintah).
2. `/import { ...json... }` — tempel JSON langsung di chat.
3. `/import replace { ...json... }` — **timpa semua** data lama user.
4. Kirim file dengan caption `replace` untuk mode timpa.

Default `/import` adalah **merge**: layanan lama tetap ada, entri baru/duplikat
menimpa secret dengan nama layanan yang sama. Entri dengan secret tidak valid
dilewati.

Format backup yang diterima (selain output `/export` di atas):

- **Proton Authenticator**: `{"version":1,"entries":[{"content":{"uri":"otpauth://...","name":"..."}}]}`
- **Google Authenticator**: `{"services":[{"secret":"...","name":"...","issuer":"..."}]}`
- **Aegis Authenticator**: `{"version":1,"entries":[{"secret":"...","name":"..."}]}`
- Array objek: `[{"service":"github","secret":"..."}]`
- Object polos: `{"github":"SECRET"}`
- Teks/array berisi URL `otpauth://...`

Secret diambil dari field `secret` atau dari URL `otpauth://` (termasuk format
dengan pemisah `+`/spasi). Nama layanan dari aplikasi authenticator yang
mengandung spasi, `@`, atau karakter lain otomatis diubah menjadi slug yang
valid, mis. `Google alfimuhamad40` → `google-alfimuhamad40`. Gunakan `/list`
untuk melihat nama layanan hasil import, lalu `/code <nama>` untuk OTP-nya.

Batasan: maksimal 200 layanan per user dan 1 MiB per file import.

## Auto-hapus pesan

- Pesan/default balasan bot dihapus otomatis setelah **30 detik**.
- Pesan `/list` (perintah user **dan** balasan daftar layanan) dipertahankan
  lebih lama: **60 detik** (`LIST_CLEANUP_DELAY_SECONDS`).
- `/start` beserta balasannya sengaja **tidak dihapus**.

Penjadwalannya memakai antrean Cloudflare `totp-message-cleanup` (binding
`CLEANUP_QUEUE`), bukan `waitUntil()`, karena `waitUntil()` maksimal 30 detik
dan bisa dibatalkan. Alurnya: webhook mengirim job berisi `chat_id` + daftar
`message_id` dengan `delaySeconds` sesuai jenis pesan, lalu consumer di Worker
yang sama memanggil `deleteMessage` Telegram. Error 4xx (misal pesan sudah
dihapus manual) diabaikan; 5xx/gangguan jaringan memicu retry otomatis antrean.

Ganti jeda default lewat `CLEANUP_DELAY_SECONDS`, atau jeda `/list` lewat
`LIST_CLEANUP_DELAY_SECONDS` di `src/cleanup.ts`, lalu deploy ulang.

---

## Development lokal

```bash
cp .dev.vars.example .dev.vars
# isi TELEGRAM_BOT_TOKEN, WEBHOOK_SECRET, ALLOWED_USERS

npm run dev
```

Karena Telegram butuh URL publik, buat tunnel dengan cloudflared:

```bash
cloudflared tunnel --url http://localhost:8787
```

Lalu daftarkan URL tunnel tersebut sebagai webhook (dengan `secret_token` yang sama
dengan `.dev.vars`). Perubahan webhook perlu di-set ulang setiap kali URL tunnel berubah.

## Catatan keamanan

- Simpan backup hasil `/export` di tempat aman; siapa pun yang punya file itu bisa
  membuat OTP Anda. Bot tidak pernah menampilkan secret utuh di `/list` maupun `/code`.
- Gunakan `WEBHOOK_SECRET` yang acak dan panjang agar endpoint tidak bisa dipanggil pihak lain.
- `WEBHOOK_PATH` bisa diganti ke path yang tidak mudah ditebak, mis. `/hook-<acak>`.
- Nilai secret di KV **tidak disimpan sebagai teks biasa**, melainkan ciphertext
  AES-GCM (`enc:v1:<iv>.<ciphertext>`) memakai `ENCRYPTION_KEY`. Data lama yang
  masih berupa teks biasa otomatis dienkripsi ulang saat pertama kali dibaca.
  Nama layanan tetap menjadi bagian dari kunci KV (`user_<id>_<service>`) agar
  daftar layanan bisa ditampilkan.
- Jangan pernah mengganti/hilangkan `ENCRYPTION_KEY` setelah data tersimpan.
- Jika bot diubah webhook-nya, pastikan `secret_token` ikut diperbarui.
