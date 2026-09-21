/** Run locally; --live requires the operator's explicit authorization for Telegram delivery. */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createPrivateKey } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = dotenv.parse(readFileSync(join(root, '.env')));
const mode = process.argv[2] ?? '--dry-run';
if (!['--dry-run', '--live'].includes(mode)) throw new Error('Use --dry-run or explicitly authorized --live');
const live = mode === '--live';
if (!env.GMGN_API_KEY || !env.GMGN_PRIVATE_KEY) throw new Error('GMGN API Key and signing key are required');
createPrivateKey(env.GMGN_PRIVATE_KEY.replace(/\\n/g, '\n'));
const entries = {
  GMGN_API_KEY: env.GMGN_API_KEY,
  GMGN_PRIVATE_KEY: env.GMGN_PRIVATE_KEY,
  GMGN_RATE_LIMIT_PER_SEC: env.GMGN_RATE_LIMIT_PER_SEC ?? '10',
  GMGN_RATE_LIMIT_AUTO_RETRY_MAX_WAIT_MS: '0',
  DRY_RUN: live ? '0' : '1',
};
if (live) {
  for (const key of ['TG_BOT_TOKEN', 'TG_CHAT_ID', 'TG_ADMIN_IDS']) {
    if (!env[key]?.trim()) throw new Error(`Missing ${key} for live deployment`);
    entries[key] = env[key];
  }
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(entries.TG_BOT_TOKEN)) throw new Error('Invalid bot token format');
  if (!/^-?\d+$/.test(entries.TG_CHAT_ID)) throw new Error('Invalid numeric chat ID');
  if (!entries.TG_ADMIN_IDS.split(',').every(value => /^\d+$/.test(value.trim()))) throw new Error('Invalid admin IDs');
}
const dir = join(root, 'data', 'deployment');
mkdirSync(dir, { recursive: true, mode: 0o700 });
chmodSync(dir, 0o700);
const target = join(dir, 'sea.env');
writeFileSync(target, Object.entries(entries).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n', { mode: 0o600 });
chmodSync(target, 0o600);
console.log(JSON.stringify({ prepared: 'data/deployment/sea.env', fields: Object.keys(entries), telegramCredentialsIncluded: live, dryRun: !live, mode: '600' }));
