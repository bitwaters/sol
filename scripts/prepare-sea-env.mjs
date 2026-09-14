/** Run locally: prepare the minimum credentials for SEA dry-run deployment. */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createPrivateKey } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = dotenv.parse(readFileSync(join(root, '.env')));
if (env.DRY_RUN !== '1') throw new Error('Prepare the local configuration with DRY_RUN=1 first');
if (!env.GMGN_API_KEY || !env.GMGN_PRIVATE_KEY) throw new Error('GMGN API Key and signing key are required');
createPrivateKey(env.GMGN_PRIVATE_KEY.replace(/\\n/g, '\n'));
const entries = {
  GMGN_API_KEY: env.GMGN_API_KEY,
  GMGN_PRIVATE_KEY: env.GMGN_PRIVATE_KEY,
  GMGN_RATE_LIMIT_PER_SEC: env.GMGN_RATE_LIMIT_PER_SEC ?? '20',
  GMGN_RATE_LIMIT_AUTO_RETRY_MAX_WAIT_MS: '0',
  DRY_RUN: '1',
};
const dir = join(root, 'data', 'deployment');
mkdirSync(dir, { recursive: true, mode: 0o700 });
chmodSync(dir, 0o700);
const target = join(dir, 'sea.env');
writeFileSync(target, Object.entries(entries).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n', { mode: 0o600 });
chmodSync(target, 0o600);
console.log(JSON.stringify({ prepared: 'data/deployment/sea.env', fields: Object.keys(entries), telegramCredentialsIncluded: false, mode: '600' }));
