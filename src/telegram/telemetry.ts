import { measureAsync } from '../ops/metrics.js';
import type { TelegramApi } from './types.js';

export function measureTelegram(sender: TelegramApi): TelegramApi {
  return {
    sendMessage: (...args) => measureAsync('telegram.send', () => sender.sendMessage(...args)),
    ...(sender.deleteMessage ? { deleteMessage: (chatId: string, messageId: number) => measureAsync('telegram.delete', () => sender.deleteMessage!(chatId, messageId)) } : {}),
    editMessageText: (...args) => measureAsync('telegram.edit', () => sender.editMessageText(...args)),
  };
}
