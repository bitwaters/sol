/** Bounded, read-only contract probe. Prints only aggregate evidence, never wallet records. */
import { loadConfig } from '../config.js';
import { OpenApiClient } from '../gmgn/OpenApiClient.js';
import { extractFollowNextToken } from '../ingest/poller.js';
import { normalizeTrackResponse } from '../ingest/normalize.js';
import { setTimeout as wait } from 'node:timers/promises';

const { env } = loadConfig();
if (process.argv[2] !== '--run') throw new Error('Explicit --run required');
const variants = process.argv.includes('--variants');
const client = new OpenApiClient({ host: 'https://openapi.gmgn.ai', apiKey: env.GMGN_API_KEY,
  privateKeyPem: env.GMGN_PRIVATE_KEY?.replace(/\\n/g, '\n'), autoRetryOnRateLimit: false });
try {
  const first = await client.getFollowWallet('sol', { limit: 100 });
  const trades = normalizeTrackResponse('follow', first);
  const next = extractFollowNextToken(first);
  const ids = new Set(trades.map(row => row.eventId));
  const minTs = trades.length ? Math.min(...trades.map(row => row.timestamp)) : null;
  console.log(JSON.stringify({ stage: 'first_page', count: trades.length, hasNextToken: Boolean(next), oldestTs: minTs }));
  const list = (first as { list?: Array<{ id?: unknown }> })?.list;
  const lastId = list?.at(-1)?.id;
  const candidates: Array<{ parameter: string; value: string; origin: string }> = [];
  if (next) candidates.push({ parameter: 'next_page_token', value: next, origin: 'next_page_token' });
  if (variants && typeof lastId === 'string') {
    for (const parameter of ['cursor', 'next_page_token', 'page_token']) {
      candidates.push({ parameter, value: lastId, origin: 'last_record_id' });
    }
  }
  let verified = false;
  for (const candidate of candidates) {
    await wait(3000);
    const started = performance.now();
    const second = await client.getFollowWallet('sol', { limit: 100, [candidate.parameter]: candidate.value });
    const rows = normalizeTrackResponse('follow', second);
    const older = rows.filter(row => minTs !== null && row.timestamp < minTs).length;
    console.log(JSON.stringify({ stage: 'next_page', parameter: candidate.parameter, origin: candidate.origin, count: rows.length,
      overlap: rows.filter(row => ids.has(row.eventId)).length, olderRows: older,
      cursorChanged: extractFollowNextToken(second) !== next, durationMs: Math.round(performance.now() - started),
      paginationVerified: older > 0 }));
    if (older > 0) verified = true;
  }
  if (!verified) process.exitCode = 2;
} catch (error) {
  const candidate = error as { status?: number; apiError?: string; resetAtUnix?: number };
  console.log(JSON.stringify({ probeFailed: true, status: candidate.status,
    rateLimited: candidate.status === 429, resetAtUnix: candidate.resetAtUnix }));
  process.exitCode = 1;
}
