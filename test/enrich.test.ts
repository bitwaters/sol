import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROJECT_ROOT } from '../src/config.js';
import { enrichToken } from '../src/enrich/token.js';
import {
  enrichWallets,
  getWalletProfile,
  isExcludedFunder,
  loadCexBlacklist,
} from '../src/enrich/wallet.js';
import { openDatabase } from '../src/store/db.js';
import tokenInfoFixture from './fixtures/token-info.json' with { type: 'json' };
import tokenSecurityFixture from './fixtures/token-security.json' with { type: 'json' };
import walletStatsFixture from './fixtures/wallet-stats.json' with { type: 'json' };

describe('enrichToken', () => {
  it('按 §6.2 映射解析字段并分层缓存', async () => {
    const db = openDatabase({ path: ':memory:' });
    let infoCalls = 0;
    let securityCalls = 0;
    const gateway = {
      fetchTokenInfo: async () => {
        infoCalls += 1;
        return tokenInfoFixture;
      },
      fetchTokenSecurity: async () => {
        securityCalls += 1;
        return tokenSecurityFixture;
      },
    };
    const base = Date.now();

    const snap1 = await enrichToken(db, gateway, 'token-addr', { now: () => base });
    expect(infoCalls).toBe(1);
    expect(securityCalls).toBe(1);
    expect(snap1.price).not.toBeNull();
    expect(snap1.marketCap).toBeGreaterThan(0);
    expect(snap1.createdAt).not.toBeNull();
    expect(snap1.bundlerRate).not.toBeNull();
    expect(snap1.insiderRate).not.toBeNull();
    expect(snap1.entrapmentRate).not.toBeNull();
    expect(snap1.botDegenRate).not.toBeNull();
    expect(snap1.sniperCount).not.toBeNull();
    expect(snap1.honeypot).toBe(0);
    expect(snap1.renouncedMint).toBe(true);
    expect(snap1.renouncedFreeze).toBe(true);
    expect(snap1.missing).toEqual([]);

    // TTL 内不重复请求
    await enrichToken(db, gateway, 'token-addr', { now: () => base + 30_000 });
    expect(infoCalls).toBe(1);
    expect(securityCalls).toBe(1);

    // 价格 TTL（60s）过期 → 只刷新 info；风险 TTL（5min）未到 → 不刷 security
    await enrichToken(db, gateway, 'token-addr', { now: () => base + 61_000 });
    expect(infoCalls).toBe(2);
    expect(securityCalls).toBe(1);

    // 风险 TTL 过期 → 刷新 security
    await enrichToken(db, gateway, 'token-addr', { now: () => base + 6 * 60_000 });
    expect(securityCalls).toBe(2);
    db.close();
  });

  it('字段缺失时记录 missing 清单', async () => {
    const db = openDatabase({ path: ':memory:' });
    const gateway = {
      fetchTokenInfo: async () => ({ price: { price: '1' } }),
      fetchTokenSecurity: async () => ({}),
    };
    const snap = await enrichToken(db, gateway, 'sparse');
    expect(snap.missing).toContain('liquidity');
    expect(snap.missing).toContain('honeypot');
    expect(snap.missing).toContain('renounced_mint');
    db.close();
  });
});

describe('enrichWallets', () => {
  it('解析 portfolio stats 并落库', async () => {
    const db = openDatabase({ path: ':memory:' });
    const gateway = { fetchWalletStats: async () => walletStatsFixture };
    const address = 'sample-address-105';
    const map = await enrichWallets(db, gateway, [address]);
    const profile = map.get(address);
    expect(profile).toBeDefined();
    expect(profile?.fundFromAddress).not.toBeNull();
    expect(profile?.walletCreatedAt).not.toBeNull();
    expect(profile?.tags).toContain('smart_degen');

    const stored = getWalletProfile(db, address);
    expect(stored?.fundFromAddress).toBe(profile?.fundFromAddress);
    db.close();
  });
});

describe('CEX blacklist', () => {
  it('加载并命中排除类别', () => {
    const blacklist = loadCexBlacklist(join(PROJECT_ROOT, 'data', 'cex-blacklist.json'));
    expect(blacklist.entries.size).toBeGreaterThan(0);
    expect(isExcludedFunder(blacklist, '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9', ['cex'])).toBe(
      true,
    );
    expect(isExcludedFunder(blacklist, 'unknown-address', ['cex'])).toBe(false);
    expect(isExcludedFunder(blacklist, null, ['cex'])).toBe(false);
  });
});
