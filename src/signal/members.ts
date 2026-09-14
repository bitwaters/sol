import { Decimal } from 'decimal.js';
import type { Db } from '../store/db.js';

/** 已推送信号按固定成员的绑定周期计算保留率，已清仓成员仍在分母内。 */
export function boundHoldingRatio(db: Db, signalId: number): number | null {
  const rows = db.prepare(`SELECT p.bought_amount, p.sold_amount FROM signal_wallets sw
    JOIN signals s ON s.id = sw.signal_id
    JOIN wallet_positions p ON p.wallet = sw.wallet AND p.token = s.token AND p.cycle_no = sw.cycle_no
    WHERE sw.signal_id = ? AND p.cost_complete = 1 AND p.state IN ('open','closed')`).all(signalId) as Array<{ bought_amount: string; sold_amount: string }>;
  let bought = new Decimal(0); let remaining = new Decimal(0);
  for (const row of rows) {
    bought = bought.plus(row.bought_amount);
    remaining = remaining.plus(Decimal.max(0, new Decimal(row.bought_amount).minus(row.sold_amount)));
  }
  return bought.gt(0) ? remaining.div(bought).toNumber() : null;
}

export function closedBoundClusters(db: Db, signalId: number): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM (
    SELECT COALESCE(sw.cluster_id,sw.wallet) AS cluster FROM signal_wallets sw
    JOIN signals s ON s.id = sw.signal_id
    LEFT JOIN wallet_positions p ON p.wallet=sw.wallet AND p.token=s.token AND p.cycle_no=sw.cycle_no
    WHERE sw.signal_id = ? GROUP BY COALESCE(sw.cluster_id,sw.wallet)
    HAVING COUNT(*) = SUM(CASE WHEN p.state='closed' THEN 1 ELSE 0 END))`).get(signalId) as { n: number };
  return row.n;
}
