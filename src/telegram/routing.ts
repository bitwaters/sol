/** Administrative output is private and never falls back to the signal channel. */
export function adminRecipients(adminIds: string[], signalChatId?: string): string[] {
  return [...new Set(adminIds.map(id => id.trim()).filter(id => /^[1-9]\d*$/.test(id) && id !== signalChatId))];
}
