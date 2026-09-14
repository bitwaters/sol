/** Isolated wire-level fault drill: localhost mock API, synthetic events, no production credentials. */
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { OpenApiClient } from '../gmgn/OpenApiClient.js';
import { GmgnGateway, RateLimitedError } from '../ingest/gateway.js';
import { BanGate, TokenBucket } from '../ingest/limiter.js';
import { Poller } from '../ingest/poller.js';
import { openDatabase } from '../store/db.js';
import { getSourceHealth } from '../store/repo/health.js';
import { createLogger } from '../logger.js';

const logger = createLogger();
for (const method of ['debug', 'info', 'warn', 'error'] as const) logger[method] = () => {};
let mode: 'ok' | '429' = 'ok';
let requests = 0;
const timestamp = Math.floor(Date.now() / 1000) - 10;
const server = createServer((_req, res) => {
  requests++;
  res.setHeader('content-type', 'application/json');
  if (mode === '429') {
    res.statusCode = 429;
    res.end(JSON.stringify({ code: 429, error: 'RATE_LIMIT_EXCEEDED', reset_at: Math.floor(Date.now() / 1000) + 1 }));
  } else {
    res.end(JSON.stringify({ code: 0, data: { list: [{ transaction_hash: 'synthetic-tx', maker: 'synthetic-wallet',
      base_address: 'synthetic-token', side: 'buy', timestamp, token_amount: '100', amount_usd: '1000' }] } }));
  }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert(address && typeof address !== 'string');
const port = address.port;
const directory = mkdtempSync(join(tmpdir(), 'sol-fault-'));
let db = openDatabase({ path: join(directory, 'test.sqlite') });
try {
  const gateway = new GmgnGateway({ client: new OpenApiClient({ host: `http://127.0.0.1:${port}`,
    apiKey: 'synthetic-test-key', timeoutMs: 500, autoRetryOnRateLimit: false }),
    limiter: new TokenBucket({ ratePerSecond: 10, capacity: 5 }), banGate: new BanGate(), logger });
  const makePoller = () => new Poller({ source: 'smartmoney', intervalMs: 100, limit: 100,
    db, logger, fetchPage: () => gateway.fetchSmartmoney(100) });
  const poller = makePoller();
  assert.equal((await poller.tick()).insertedEvents, 1);
  const original = getSourceHealth(db, 'smartmoney');
  await new Promise<void>(resolve => server.close(() => resolve()));
  assert.equal(typeof (await poller.tick()).error, 'string');
  assert.deepEqual(getSourceHealth(db, 'smartmoney'), original);
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  assert.equal((await poller.tick()).insertedEvents, 0);
  mode = '429';
  await assert.rejects(gateway.fetchSmartmoney(100), RateLimitedError);
  const before = requests;
  mode = 'ok';
  const recovery = gateway.fetchSmartmoney(100);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(requests, before);
  await recovery;
  assert.equal(requests, before + 1);
  db.close();
  db = openDatabase({ path: join(directory, 'test.sqlite') });
  assert.equal((await makePoller().tick()).insertedEvents, 0);
  assert.equal(db.pragma('quick_check', { simple: true }), 'ok');
  console.log(JSON.stringify({ synthetic: true, externalRequests: 0, connectionFailureRecovery: 'pass',
    wire429BanAndRecovery: 'pass', persistedDatabaseReopen: 'pass', productionDatabaseTouched: false }));
} finally {
  db.close(); server.close(); rmSync(directory, { recursive: true, force: true });
}
