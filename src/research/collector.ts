import { createHash } from 'node:crypto';
import type { AppConfig } from '../config.js';
import { enrichToken } from '../enrich/token.js';
import { parseWalletStats, getWalletProfile, WALLET_PROFILE_TTL_SEC, type CexBlacklist, type WalletProfile } from '../enrich/wallet.js';
import { fresh } from '../backtest/features.js';
import { validPrice } from '../backtest/quality.js';
import { BackgroundBusyError } from '../ingest/gateway.js';
import type { GmgnGateway } from '../ingest/gateway.js';
import type { Logger } from '../logger.js';
import { getKv, setKv, type Db } from '../store/db.js';
import { RESEARCH_VERSION, type ResearchConfig } from './config.js';
import { diagnose } from './diagnostics.js';
import { freezeSnapshot, pack, unpack, restoreSnapshot, SnapshotLimitError } from './snapshot.js';

export interface ResearchDeps {
  db: Db; config: AppConfig; research: ResearchConfig; researchVersion: string;
  configVersion: string; rulesVersion: string; blacklist: CexBlacklist; logger: Logger;
  gateway: ReturnType<GmgnGateway['background']>; now?: () => number;
}
const nowOf = (d: ResearchDeps) => Math.floor((d.now?.() ?? Date.now()) / 1000);
/** Stable hash selection before enrichment/outcomes. Each token has the same probability within its stratum. */
export function reserveResearch(d: ResearchDeps): number {
  const { db,research } = d, now = nowOf(d);
  if (!research.enabled || now - (getKv<number>(db,'research_last_sample') ?? 0) < research.intervalSec) return 0;
  const candidates = db.prepare(`SELECT base_address token,COUNT(DISTINCT maker) votes FROM trades
    WHERE chain='sol' AND side='buy' AND timestamp BETWEEN ? AND ? AND amount_usd_num>0 GROUP BY base_address`)
    .all(now-research.windowMinutes*60,now) as { token: string; votes: number }[];
  const queued = (db.prepare("SELECT COUNT(*) n FROM research_samples WHERE state='pending'").get() as {n:number}).n;
  let capacity = Math.max(0,research.maxPending-queued);
  const version = `${RESEARCH_VERSION}:${d.researchVersion}`;
  const groups = [1,2,3,4,5].map(stratum => {
    const rows = candidates.filter(c=>Math.min(c.votes,5)===stratum).sort((a,b)=>{
      const hash = (token:string) => createHash('sha256').update(`${version}:${now}:${token}`).digest('hex');
      return hash(a.token).localeCompare(hash(b.token));
    });
    return { stratum,rows,selected: [] as typeof rows };
  });
  // Rotate allocation order to avoid starving large-vote strata when the queue is nearly full.
  const offset = Math.floor(now/research.intervalSec)%5;
  for(let round=0;round<research.maxPerStratum;round++) for(let i=0;i<5;i++) {
    const g=groups[(i+offset)%5]!;if(capacity>0&&g.rows[round]) {g.selected.push(g.rows[round]!);capacity--;}
  }
  let selected=0;
  db.transaction(()=>{
    const run = Number(db.prepare('INSERT INTO research_runs(sampled_at,version,universe,selected,strata) VALUES (?,?,?,?,?)')
      .run(now,version,candidates.length,groups.reduce((n,g)=>n+g.selected.length,0),JSON.stringify(groups.map(g=>({stratum:g.stratum,universe:g.rows.length,selected:g.selected.length})))).lastInsertRowid);
    for(const g of groups) for(const row of g.selected) {
      let initial:Buffer|null=null,error:string|null=null;
      try {initial=pack(freezeSnapshot(db,row.token,now,d.config,research,d.blacklist));}
      catch(e) {if(!(e instanceof SnapshotLimitError))throw e;error='snapshot_size_limit';}
      db.prepare(`INSERT INTO research_samples(run_id,token,selected_at,stratum,probability,config_version,rules_version,research_version,state,initial,error)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(run,row.token,now,g.stratum,g.selected.length/g.rows.length,d.configVersion,d.rulesVersion,version,error?'unavailable':'pending',initial,error);
      selected++;
    }
    setKv(db,'research_last_sample',now,now);
  })();
  return selected;
}
const running = new WeakSet<Db>();
export async function collectResearch(d: ResearchDeps) {
  if (!d.research.enabled || running.has(d.db)) return;
  running.add(d.db);
  try {
    const rows = d.db.prepare("SELECT id,token,selected_at,initial FROM research_samples WHERE state='pending' ORDER BY id LIMIT ?")
      .all(d.research.maxPerBatch) as {id:number;token:string;selected_at:number;initial:Buffer}[];
    for(const row of rows) {
      let frozen=unpack(row.initial), error:string|null=null;
      if(nowOf(d)-row.selected_at<=120) {
        const isolated=restoreSnapshot(frozen);
        try {
          const profiles:WalletProfile[]=[];
          const recentMakers = isolated.prepare("SELECT DISTINCT maker FROM trades WHERE side='buy' AND timestamp>=?")
            .all(frozen.at-d.research.windowMinutes*60) as {maker:string}[];
          const missing=recentMakers.map(r=>r.maker).filter(w=>{const p=getWalletProfile(isolated,w);return !p||!fresh(p.refreshedAt,frozen.at,WALLET_PROFILE_TTL_SEC);});
          for(const wallet of missing.slice(0,d.research.maxWalletRefresh)) {
            const started=nowOf(d),raw=await d.gateway.fetchWalletStats(wallet);
            profiles.push(...parseWalletStats(raw).filter(p=>p.address===wallet).map(p=>({...p,refreshedAt:started})));
          }
          const quote=await enrichToken(isolated,d.gateway,row.token,{now:d.now,persist:false,logger:d.logger});
          if(nowOf(d)-row.selected_at<=120) frozen=freezeSnapshot(d.db,row.token,nowOf(d),d.config,d.research,d.blacklist,quote,profiles);
          else error='capture_deadline';
        } catch(e) {
          if(e instanceof BackgroundBusyError && nowOf(d)-row.selected_at<=120) continue;
          error=e instanceof SnapshotLimitError?'snapshot_size_limit':'enrichment_unavailable';
        } finally {isolated.close();}
      } else error='capture_deadline';
      const diagnostic=diagnose(frozen);
      const price=frozen.quote?.price ?? null, priceAt=frozen.quote?.priceUpdatedAt ?? null;
      const live=validPrice(price)&&fresh(priceAt,frozen.at,60);
      d.db.transaction(()=>{
        d.db.prepare(`UPDATE research_samples SET state=?,anchor_at=?,baseline=?,price_at=?,frozen=?,diagnostics=?,error=? WHERE id=? AND state='pending'`)
          .run(live?'ready':'unavailable',frozen.at,live?price:null,priceAt,pack(frozen),JSON.stringify(diagnostic),error,row.id);
        for(const horizon of [300,3600,86400]) d.db.prepare(`INSERT OR IGNORE INTO research_outcomes(sample_id,horizon,state,next_at) VALUES (?,?,?,?)`)
          .run(row.id,horizon,live?'pending':'missing_baseline',frozen.at+horizon);
      })();
    }
  } finally {running.delete(d.db);}
}
