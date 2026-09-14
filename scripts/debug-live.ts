/** 只读 GMGN 联调：独立数据库、汇总输出，不启动 Telegram。 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProxyAgent, setGlobalDispatcher } from 'undici';
import { loadConfig, PROJECT_ROOT } from '../src/config.js';
import { loadCexBlacklist } from '../src/enrich/wallet.js';
import { OpenApiClient } from '../src/gmgn/OpenApiClient.js';
import { GmgnGateway } from '../src/ingest/gateway.js';
import { BanGate, TokenBucket } from '../src/ingest/limiter.js';
import { extractFollowNextToken, Poller, type PollTickResult } from '../src/ingest/poller.js';
import type { Logger } from '../src/logger.js';
import { evaluateToken } from '../src/signal/candidate.js';
import { applyIngestedTrades } from '../src/signal/ingest.js';
import { openDatabase, setKv } from '../src/store/db.js';

const loaded = loadConfig();
const seconds = Number(process.env['DEBUG_DURATION_SEC'] ?? 1800);
if (!Number.isInteger(seconds) || seconds < 1 || seconds > 7200) throw new Error('DEBUG_DURATION_SEC must be 1..7200');
if (!loaded.env.GMGN_PRIVATE_KEY) throw new Error('Signed follow credentials are required');
delete process.env.GMGN_DEBUG;
if (loaded.env.GMGN_PROXY) setGlobalDispatcher(new ProxyAgent(loaded.env.GMGN_PROXY));
const started = Date.now();
const dir = join(PROJECT_ROOT, 'data', 'debug', new Date(started).toISOString().replace(/[:.]/g, '-'));
mkdirSync(dir, { recursive: true, mode: 0o700 });
const dbPath = join(dir, 'debug.sqlite');
const db = openDatabase({ path: dbPath });
chmodSync(dbPath, 0o600);
setKv(db, 'observation_started_at', Math.floor(started / 1000));
const logs: Record<string, number> = {};
const errorKinds: Record<string, number> = {};
const logger: Logger = {
  debug() {}, info() {},
  warn: msg => { logs[`warn:${msg}`] = (logs[`warn:${msg}`] ?? 0) + 1; },
  error: (msg, fields) => {
    logs[`error:${msg}`] = (logs[`error:${msg}`] ?? 0) + 1;
    // 仅记录错误类型／状态码，不输出 URL、请求头、原始响应或钱包数据。
    const error = fields?.['error'] as { name?: unknown; status?: unknown; apiError?: unknown; cause?: { code?: unknown } } | undefined;
    const key = [error?.name, error?.status, error?.apiError, error?.cause?.code]
      .filter(value => typeof value === 'number' || (typeof value === 'string' && /^[A-Za-z0-9_]+$/.test(value))).join(':') || 'unclassified';
    errorKinds[key] = (errorKinds[key] ?? 0) + 1;
  },
  child() { return logger; },
};
const gateway = new GmgnGateway({
  client: new OpenApiClient({ apiKey: loaded.env.GMGN_API_KEY, privateKeyPem: loaded.env.GMGN_PRIVATE_KEY.replace(/\\n/g, '\n'), host: 'https://openapi.gmgn.ai', autoRetryOnRateLimit: false }),
  limiter: new TokenBucket({ ratePerSecond: loaded.env.GMGN_RATE_LIMIT_PER_SEC, capacity: Math.max(5, loaded.env.GMGN_RATE_LIMIT_PER_SEC) }),
  banGate: new BanGate(), logger,
});
const engineDeps = { ...loaded, db, gateway, logger, blacklist: loadCexBlacklist(join(PROJECT_ROOT, 'data', 'cex-blacklist.json')) };
const totals: Record<string, { ticks: number; fetched: number; inserted: number; gaps: number; stalled: number; errors: number; rateLimited: number }> = {};
const evaluations: Record<string, number> = {};
let stop = false;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const remaining = () => Math.max(0, started + seconds * 1000 - Date.now());
function record(result: PollTickResult) {
  const count = totals[result.source] ??= { ticks: 0, fetched: 0, inserted: 0, gaps: 0, stalled: 0, errors: 0, rateLimited: 0 };
  count.ticks++; count.fetched += result.fetched; count.inserted += result.insertedEvents;
  count.gaps += Number(result.gapDetected); count.stalled += Number(result.paginationStalled === true);
  if (result.error) { count.errors++; if (/RATE_LIMIT/.test(result.error)) count.rateLimited++; }
}
function report(final: boolean) {
  const summary = {
    startedAt: new Date(started).toISOString(), elapsedSeconds: Math.round((Date.now() - started) / 1000), final,
    configVersion: loaded.configVersion, rulesVersion: loaded.rulesVersion, telegramEnabled: false, totals, evaluations, logs, errorKinds,
    trades: db.prepare('SELECT COUNT(*) n FROM trades').get(),
    sourceObservations: db.prepare('SELECT source,COUNT(*) n FROM trade_sources GROUP BY source').all(),
    positions: db.prepare('SELECT state,cost_complete,COUNT(*) n FROM wallet_positions GROUP BY state,cost_complete').all(),
    sources: db.prepare('SELECT source,last_success_at,watermark_ts,gap_from_ts,gap_to_ts FROM source_health').all(),
    signals: db.prepare('SELECT status,COUNT(*) n FROM signals GROUP BY status').all(),
    databaseIntegrity: final ? db.pragma('integrity_check', { simple: true }) : undefined,
  };
  writeFileSync(join(dir, 'summary.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(summary));
}
async function poll(source: 'smartmoney' | 'kol' | 'follow') {
  const settings = source === 'follow' ? loaded.config.polling.followWallet : loaded.config.polling[source];
  const poller = new Poller({ source, ...settings, db, logger,
    paginate: source === 'follow', extractNextToken: source === 'follow' ? extractFollowNextToken : undefined,
    fetchPage: ({ limit, nextPageToken }) => source === 'follow' ? gateway.fetchFollowWallet({ limit, nextPageToken }) : source === 'kol' ? gateway.fetchKol(limit) : gateway.fetchSmartmoney(limit),
    onTrades: (_source, trades) => applyIngestedTrades(db, trades, loaded.config.signalValidation.positionDustRatio, logger),
  });
  while (!stop && remaining() > 0) {
    const result = await poller.tick();
    record(result);
    await sleep(Math.min(result.nextIntervalMs, remaining()));
  }
}
async function evaluate() {
  while (!stop && remaining() > 0) {
    await sleep(Math.min(30000, remaining()));
    if (stop || remaining() <= 0) break;
    const tokens = db.prepare(`SELECT base_address AS token FROM trades WHERE side='buy' AND timestamp>=?
      GROUP BY base_address HAVING COUNT(DISTINCT maker)>=? ORDER BY MAX(timestamp) DESC LIMIT 3`)
      .all(Math.floor(Date.now() / 1000) - loaded.config.signal.windowMinutes * 60, loaded.config.signal.minDistinctWallets) as Array<{ token: string }>;
    for (const { token } of tokens) {
      if (stop || remaining() <= 0) break;
      try { const result = await evaluateToken(engineDeps, token); const key = result.reason?.replace(/\(.*/, '') ?? result.status; evaluations[key] = (evaluations[key] ?? 0) + 1; }
      catch { evaluations['exception'] = (evaluations['exception'] ?? 0) + 1; }
    }
  }
}
console.log(JSON.stringify({ debugDir: dir, durationSeconds: seconds, telegramEnabled: false }));
process.on('SIGINT', () => { stop = true; });
process.on('SIGTERM', () => { stop = true; });
const timer = setInterval(() => report(false), 60000);
try { await Promise.all([poll('smartmoney'), poll('kol'), poll('follow'), evaluate()]); }
finally { clearInterval(timer); report(true); db.close(); }
