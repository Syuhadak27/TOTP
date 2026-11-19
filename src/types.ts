export interface Env {
  AUTH_KV: KVNamespace;
  CLEANUP_QUEUE: Queue<CleanupJob>;
  TELEGRAM_BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  /** Kunci AES-GCM untuk mengenkripsi secret di KV (base64, 32 byte). */
  ENCRYPTION_KEY: string;
  ALLOWED_USERS?: string;
  WEBHOOK_PATH?: string;
}

/** Payload antrean untuk menghapus pesan setelah jeda tertentu. */
export interface CleanupJob {
  chatId: number;
  messageIds: number[];
}

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  username?: string;
  first_name?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
}

export interface TelegramDocument {
  file_id: string;
  file_name?: string;
  file_size?: number;
  mime_type?: string;
  caption?: string;
}

export interface TelegramMessage {
  message_id: number;
  date: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  document?: TelegramDocument;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}
