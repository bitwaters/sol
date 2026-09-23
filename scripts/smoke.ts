/**
 * M1-15 冒烟验收：真实 API 短时运行（demo key 限速 1 req/s）
 *
 * 用法：GMGN_RATE_LIMIT_PER_SEC=1 SMOKE_CYCLES=15 npx tsx scripts/smoke.ts
 * 输出：采集统计 + source_health + 错误/限频计数
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { OpenApiClient } from '../src/gmgn/OpenApiClient.js';
import { GmgnGateway, ROUTE_WEIGHTS } from '../src/ingest/gateway.js';
import { BanGate, TokenBucket } from '../src/ingest/limiter.js';
import { extractFollowNextToken, Poller } from '../src/ingest/poller.js';
import { createLogger } from '../src/logger.js';
import { openDatabase } from '../src/store/db.js';
import { countTradeSources, countTrades } from '../src/store/repo/trades.js';

const log = createLogger({ module: 'smoke' });
const loaded = loadConfig();
const cycles = Number(process.env['SMOKE_CYCLES'] ?? '15');
const cycleSleepMs = Number(process.env['SMOKE_CYCLE_SLEEP_MS'] ?? '2000');
const ratePerSecond = Number(process.env['GMGN_RATE_LIMIT_PER_SEC'] ?? '1');

const dir = mkdtempSync(join(tmpdir(), 'meme-smoke-'));
const db = openDatabase({ path: join(dir, 'smoke.sqlite') });
const client = new OpenApiClient({
  apiKey: loaded.env.GMGN_API_KEY,
  privateKeyPem: loaded.env.GMGN_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  host: 'https://openapi.gmgn.ai',
});
const gateway = new GmgnGateway({
  client,
  limiter: new TokenBucket({ ratePerSecond, capacity: Math.max(...Object.values(ROUTE_WEIGHTS)) }),
  banGate: new BanGate(),
  logger: log,
});

const pollers: Poller[] = [
  new Poller({
    source: 'smartmoney',
    intervalMs: loaded.config.polling.smartmoney.intervalMs,
    limit: 50,
    fetchPage: ({ limit }) => gateway.fetchSmartmoney(limit),
    db,
    logger: log.child({ source: 'smartmoney' }),
  }),
  new Poller({
    source: 'kol',
    intervalMs: loaded.config.polling.kol.intervalMs,
    limit: 50,
    fetchPage: ({ limit }) => gateway.fetchKol(limit),
    db,
    logger: log.child({ source: 'kol' }),
  }),
];

if (loaded.env.GMGN_PRIVATE_KEY) {
  pollers.push(
    new Poller({
      source: 'follow',
      intervalMs: loaded.config.polling.followWallet.intervalMs,
      limit: 50,
      fetchPage: ({ limit, nextPageToken }) =>
        gateway.fetchFollowWallet({ limit, ...(nextPageToken ? { nextPageToken } : {}) }),
      extractNextToken: extractFollowNextToken,
      paginate: true,
      db,
      logger: log.child({ source: 'follow' }),
    }),
  );
}

async function main(): Promise<void> {
  let ticks = 0;
  let fetched = 0;
  let inserted = 0;
  let rateLimited = 0;
  let errors = 0;
  let gaps = 0;

  for (let i = 0; i < cycles; i += 1) {
    for (const poller of pollers) {
      const result = await poller.tick();
      ticks += 1;
      fetched += result.fetched;
      inserted += result.insertedEvents;
      if (result.error === 'RATE_LIMIT_EXCEEDED' || result.error === 'RATE_LIMIT_BANNED') {
        rateLimited += 1;
      } else if (result.error) {
        errors += 1;
      }
      if (result.gapDetected) gaps += 1;
    }
    await new Promise((r) => setTimeout(r, cycleSleepMs));
  }

  const health = db.prepare('SELECT * FROM source_health').all() as Array<Record<string, unknown>>;
  const report = {
    cycles,
    ticks,
    fetched,
    inserted,
    rateLimited,
    errors,
    gaps,
    trades: countTrades(db),
    tradeSources: countTradeSources(db),
    health,
    followEnabled: Boolean(loaded.env.GMGN_PRIVATE_KEY),
  };
  console.log(JSON.stringify(report, null, 2));
}

main()
  .catch((err: unknown) => {
    log.error('冒烟失败', { error: err });
    process.exitCode = 1;
  })
  .finally(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
