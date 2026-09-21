export interface SendMessageOptions {
  parse_mode?: 'HTML';
  reply_parameters?: { message_id: number };
  reply_markup?: unknown;
  disable_web_page_preview?: boolean;
}

export interface TelegramApi {
  sendMessage(chatId: string, text: string, options?: SendMessageOptions): Promise<{ message_id: number }>;
  editMessageText(
    chatId: string,
    messageId: number,
    text: string,
    options?: SendMessageOptions,
  ): Promise<void>;
  deleteMessage?(chatId: string, messageId: number): Promise<void>;
  answerCallbackQuery?(callbackId: string, text?: string): Promise<void>;
}

/** Telegram 429 错误（retry_after 秒） */
export class TelegramRateLimitError extends Error {
  readonly retryAfterSec: number;
  constructor(retryAfterSec: number, message = 'telegram rate limited') {
    super(message);
    this.name = 'TelegramRateLimitError';
    this.retryAfterSec = retryAfterSec;
  }
}

/** The transport failed without a definitive Telegram response; delivery is uncertain. */
export class TelegramDeliveryUnknownError extends Error {
  constructor() {
    super('Telegram transport failed; delivery outcome is unknown');
    this.name = 'TelegramDeliveryUnknownError';
  }
}
