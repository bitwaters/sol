import { getWalletProfile, isExcludedFunder, type CexBlacklist } from '../enrich/wallet.js';
import type { Db } from '../store/db.js';

export interface ClusterOptions {
  blacklist: CexBlacklist;
  enabled?: boolean;
  sameFunder: boolean;
  creationTimeDeltaMinutes: number;
  excludeFunderLabels: string[];
}

export interface ClusterResult {
  /** wallet → clusterId */
  clusterOf: Map<string, string>;
  /** clusterId → wallets */
  clusterMembers: Map<string, string[]>;
  clusterCount: number;
}

class UnionFind {
  private readonly parent = new Map<string, string>();

  find(x: string): string {
    const p = this.parent.get(x) ?? x;
    if (p === x) {
      if (!this.parent.has(x)) this.parent.set(x, x);
      return x;
    }
    const root = this.find(p);
    this.parent.set(x, root);
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(rb, ra);
  }
}

/**
 * 关联钱包合并（M2-2，§7.2）：
 * - 同资金来源 + 创建时间接近 → 合并（CEX/桥/服务地址不据此合并）
 * - 同 tx 多钱包（bundler）→ 合并
 * - 画像缺失/资金源缺失 → 独立簇
 * 一个簇 = 1 票。
 */
export function buildClusters(
  db: Db,
  token: string,
  wallets: string[],
  options: ClusterOptions,
): ClusterResult {
  const unique = [...new Set(wallets)];
  const uf = new UnionFind();
  for (const w of unique) uf.find(w);

  // 规则 1：同资金来源 + 创建时间差 < delta
  if (options.enabled !== false && options.sameFunder) {
    const byFunder = new Map<string, Array<{ wallet: string; createdAt: number | null }>>();
    for (const wallet of unique) {
      const profile = getWalletProfile(db, wallet);
      const funder = profile?.fundFromAddress ?? null;
      if (!funder) continue;
      if (isExcludedFunder(options.blacklist, funder, options.excludeFunderLabels)) continue;
      const list = byFunder.get(funder) ?? [];
      list.push({ wallet, createdAt: profile?.walletCreatedAt ?? null });
      byFunder.set(funder, list);
    }
    const deltaSec = options.creationTimeDeltaMinutes * 60;
    for (const group of byFunder.values()) {
      if (group.length < 2) continue;
      group.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
      for (let i = 1; i < group.length; i += 1) {
        const prev = group[i - 1]!;
        const cur = group[i]!;
        const prevTs = prev.createdAt;
        const curTs = cur.createdAt;
        if (prevTs !== null && curTs !== null && Math.abs(curTs - prevTs) < deltaSec) {
          uf.union(prev.wallet, cur.wallet);
        }
      }
    }
  }

  // 规则 2：同一 tx 出现多个买入钱包
  if (options.enabled !== false && unique.length > 1) {
    const placeholders = unique.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT tx_hash, GROUP_CONCAT(DISTINCT maker) AS makers
         FROM trades
         WHERE base_address = ? AND side = 'buy' AND maker IN (${placeholders})
         GROUP BY tx_hash HAVING COUNT(DISTINCT maker) > 1`,
      )
      .all(token, ...unique) as Array<{ tx_hash: string; makers: string }>;
    for (const row of rows) {
      const makers = row.makers.split(',');
      for (let i = 1; i < makers.length; i += 1) uf.union(makers[0]!, makers[i]!);
    }
  }

  // 生成确定性簇 ID
  const membersByRoot = new Map<string, string[]>();
  for (const wallet of [...unique].sort()) {
    const root = uf.find(wallet);
    const list = membersByRoot.get(root) ?? [];
    list.push(wallet);
    membersByRoot.set(root, list);
  }

  const clusterOf = new Map<string, string>();
  const clusterMembers = new Map<string, string[]>();
  let index = 0;
  for (const walletsInCluster of [...membersByRoot.values()].sort((a, b) =>
    (a[0] ?? '').localeCompare(b[0] ?? ''),
  )) {
    const clusterId = `c${index}`;
    index += 1;
    clusterMembers.set(clusterId, walletsInCluster);
    for (const wallet of walletsInCluster) clusterOf.set(wallet, clusterId);
  }

  return { clusterOf, clusterMembers, clusterCount: clusterMembers.size };
}
