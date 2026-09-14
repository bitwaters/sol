import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { deleteKv, getKv, setKv, type Db } from '../store/db.js';
import { buildClusters } from '../signal/cluster.js';
import type { CexBlacklist } from '../enrich/wallet.js';
import { categoryLabel } from './format.js';

export interface ExitMonitorDeps {
  db: Db;
  config: AppConfig;
  logger: Logger;
  now?: () => number;
  blacklist?: CexBlacklist;
}

interface PushedSignalRow {
  id: number;
  token: string;
  sent_at: number | null;
  snapshot: string | null;
  wallet_count: number | null;
}

interface SnapshotWallet {
  wallet: string;
  clusterId: string;
  cycleNo: number | null;
  tags: string[];
  sources: string[];
}

/**
 * 推送后退出监控（M3-6）：
 * - 共识簇全部绑定周期清仓 → postPushExitAlert
 * - 非共识簇 ≥ exitAlerts.minWallets 个清仓 → 补充提醒
 * - 按 signal_id + 类型去重；监控终止后不再产生提醒
 */
export function runExitMonitor(deps: ExitMonitorDeps): number {
  const { db, config, logger } = deps;
  const nowSec = Math.floor((deps.now?.() ?? Date.now()) / 1000);
  let created = 0;

  const signals = db
    .prepare(
      `SELECT id, token, sent_at, snapshot, wallet_count FROM signals
       WHERE status = 'pushed' AND sent_at IS NOT NULL AND sent_at >= ?`,
    )
    .all(nowSec - 24 * 3600) as PushedSignalRow[];

  for (const signal of signals) {
    const age = db.prepare('SELECT created_at FROM tokens WHERE address = ?').get(signal.token) as { created_at: number | null } | undefined;
    if (age?.created_at != null && nowSec - age.created_at > 24 * 3600) {
      setKv(db, `exit_done:${signal.id}`, true, nowSec);
      continue;
    }
    // 重建可以纠正此前的清仓结论，因此仍重新核对绑定周期。


    const snapshot = signal.snapshot
      ? (JSON.parse(signal.snapshot) as { wallets?: SnapshotWallet[] })
      : {};
    const boundRows = db
      .prepare(
        `SELECT wallet, cluster_id, cycle_no, tags, source FROM signal_wallets WHERE signal_id = ?`,
      )
      .all(signal.id) as Array<{
      wallet: string;
      cluster_id: string | null;
      cycle_no: number;
      tags: string | null;
      source: string | null;
    }>;
    const wallets: SnapshotWallet[] =
      boundRows.length > 0
        ? boundRows.map((row) => ({
            wallet: row.wallet,
            clusterId: row.cluster_id ?? row.wallet,
            cycleNo: row.cycle_no,
            tags: row.tags ? (JSON.parse(row.tags) as string[]) : [],
            sources: (row.source ?? '').split(',').filter(Boolean),
          }))
        : (snapshot.wallets ?? []);
    const byCluster = new Map<string, SnapshotWallet[]>();
    for (const wallet of wallets) {
      const list = byCluster.get(wallet.clusterId) ?? [];
      list.push(wallet);
      byCluster.set(wallet.clusterId, list);
    }

    const closedCycle = db.prepare(
      `SELECT state FROM wallet_positions WHERE wallet = ? AND token = ? AND cycle_no = ?`,
    );
    const exitedClusters: Array<{ label: string; members: SnapshotWallet[] }> = [];
    for (const [clusterId, members] of byCluster) {
      void clusterId;
      const allClosed = members.every((m) => {
        if (m.cycleNo === null) return false;
        const row = closedCycle.get(m.wallet, signal.token, m.cycleNo) as
          | { state: string }
          | undefined;
        return row?.state === 'closed';
      });
      if (allClosed) {
        exitedClusters.push({
          label: categoryLabel(
            members.flatMap((m) => m.tags),
            members.flatMap((m) => m.sources),
          ),
          members,
        });
      }
    }

    if (getKv<boolean>(db, `exit_done:${signal.id}`) === true) {
      if (byCluster.size > 0 && exitedClusters.length === byCluster.size) continue;
      deleteKv(db, `exit_done:${signal.id}`);
    }

    // 共识簇退出提醒
    if (
      config.signalValidation.postPushExitAlert.enabled &&
      exitedClusters.length >= config.signalValidation.postPushExitAlert.minWallets
    ) {
      const dedupe = `${signal.id}:exit:consensus_exit`;
      const exists = db
        .prepare("SELECT 1 AS ok FROM push_tasks WHERE dedupe_key = ? AND status <> 'cancelled'")
        .get(dedupe) as { ok: number } | undefined;
      if (!exists) {
        const breakdown = new Map<string, number>();
        for (const cluster of exitedClusters) {
          breakdown.set(cluster.label, (breakdown.get(cluster.label) ?? 0) + 1);
        }
        db.prepare(
          `INSERT INTO push_tasks (signal_id, kind, alert_type, revision, dedupe_key, payload, status, created_at, updated_at)
           VALUES (?, 'exit_alert', 'consensus_exit', 0, ?, ?, 'pending', ?, ?)
           ON CONFLICT(dedupe_key) DO UPDATE SET status='pending', payload=excluded.payload, attempts=0, next_retry_at=NULL, updated_at=excluded.updated_at WHERE push_tasks.status='cancelled'`,
        ).run(
          signal.id,
          dedupe,
          JSON.stringify({
            exitedClusters: exitedClusters.length,
            clusterBreakdown: [...breakdown.entries()].map(([label, count]) => ({ label, count })),
          }),
          nowSec,
          nowSec,
        );
        created += 1;
        logger.info('创建共识簇退出提醒', { signalId: signal.id, clusters: exitedClusters.length });
      }
    }

    // 非共识簇退出（补充）：仅统计推送之后发生、且非绑定成员的已清仓钱包
    if (config.exitAlerts.enabled) {
      const otherCount = countOtherExitedClusters(db, config, signal.token, signal.sent_at ?? 0,
        wallets, deps.blacklist ?? { entries: new Map() });
      if (otherCount >= config.exitAlerts.minWallets) {
        const dedupe = `${signal.id}:exit:other_cluster_exit`;
        const exists = db
          .prepare("SELECT 1 AS ok FROM push_tasks WHERE dedupe_key = ? AND status <> 'cancelled'")
          .get(dedupe) as { ok: number } | undefined;
        if (!exists) {
          db.prepare(
            `INSERT INTO push_tasks (signal_id, kind, alert_type, revision, dedupe_key, payload, status, created_at, updated_at)
             VALUES (?, 'exit_alert', 'other_cluster_exit', 0, ?, ?, 'pending', ?, ?)
             ON CONFLICT(dedupe_key) DO UPDATE SET status='pending', payload=excluded.payload, attempts=0, next_retry_at=NULL, updated_at=excluded.updated_at WHERE push_tasks.status='cancelled'`,
          ).run(
            signal.id,
            dedupe,
            JSON.stringify({
              exitedClusters: otherCount,
              clusterBreakdown: [{ label: '其他簇', count: otherCount }],
            }),
            nowSec,
            nowSec,
          );
          created += 1;
          logger.info('创建非共识簇退出提醒', { signalId: signal.id, clusters: otherCount });
        }
      }
    }

    // 监控终止：24h / 所有共识簇退出 / 代币年龄 >24h
    const allConsensusExited =
      byCluster.size > 0 && exitedClusters.length >= byCluster.size;
    const sentAgo = signal.sent_at !== null ? nowSec - signal.sent_at : 0;
    if (allConsensusExited || sentAgo >= 24 * 3600) {
      setKv(db, `exit_done:${signal.id}`, true, nowSec);
    }
  }

  return created;
}

/** 非绑定周期的退出簇数量；排队和实际发送共用同一判定。 */
export function countOtherExitedClusters(
  db: Db, config: AppConfig, token: string, sentAt: number,
  wallets: Array<{ wallet: string; cycleNo: number | null }>,
  blacklist: CexBlacklist,
): number {
  const bound = new Set(wallets.map((w) => `${w.wallet}:${w.cycleNo}`));
  const otherClosed = db.prepare(`SELECT wallet, cycle_no FROM wallet_positions
    WHERE token = ? AND state = 'closed' AND last_sell_ts >= ?`)
    .all(token, sentAt) as Array<{ wallet: string; cycle_no: number }>;
  const others = [...new Set(otherClosed.filter(row => !bound.has(`${row.wallet}:${row.cycle_no}`)).map(row => row.wallet))];
  return buildClusters(db, token, others, {
    blacklist, enabled: config.signal.clusterMerge,
    sameFunder: config.walletFilter.cluster.sameFunder,
    creationTimeDeltaMinutes: config.walletFilter.cluster.creationTimeDeltaMinutes,
    excludeFunderLabels: config.walletFilter.cluster.excludeFunderLabels,
  }).clusterCount;
}
