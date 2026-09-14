import { measureAsync } from '../ops/metrics.js';
import type { TelegramApi } from './types.js';

export function measureTelegram(sender: TelegramApi): TelegramApi {
  return {
    sendMessage: (...args) => measureAsync('telegram.send', () => sender.sendMessage(...args)),
    editMessageText: (...args) => measureAsync('telegram.edit', () => sender.editMessageText(...args)),
  };
}
