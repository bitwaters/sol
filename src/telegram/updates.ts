import type { Db } from '../store/db.js';
import { getKv } from '../store/db.js';
import { reasonLabel, utcTime } from './labels.js';
import { signalShortId, type SignalView } from './format.js';

export interface PublishedState {votes:number;holding:number|null;condition:string;reason:string|null;}
export function publishedState(db:Db,signalId:number):PublishedState {
  const saved=getKv<PublishedState>(db,`published_state:${signalId}`);if(saved)return saved;
  const row=db.prepare('SELECT send_snapshot,holding_ratio FROM signals WHERE id=?').get(signalId) as {send_snapshot:string|null;holding_ratio:number|null};
  let snapshot:{votes?:number;holdingRatio?:number|null}={};try{snapshot=JSON.parse(row.send_snapshot??'{}');}catch{}
  return {votes:snapshot.votes??0,holding:snapshot.holdingRatio??row.holding_ratio,condition:'qualified',reason:null};
}
export function updateMessage(view:SignalView,previous:PublishedState,reason:string|null,at:number,strongWallets:number) {
  const missing=reason!==null&&/gap|missing|unavailable|verifiable|enrich|deferred|rebuild/.test(reason);
  const walletFailure=reason!==null&&/votes|wallet_count|holding_ratio|require_smart|require_open|net_inflow/.test(reason);
  const warning=reason?.startsWith('price_warn')===true;
  const condition=warning?'warning':missing?'unverified':reason?(walletFailure?'weakened':'invalidated'):'qualified';
  const state:PublishedState={votes:view.votes,holding:view.retentionRatio,condition,reason:reason?.replace(/\([^)]*\)/g,'')??null};
  const ratioChanged=previous.holding!==null&&state.holding!==null&&Math.abs(previous.holding-state.holding)>=.05;
  const changed=previous.condition!==condition||previous.reason!==state.reason||previous.votes!==state.votes||ratioChanged;
  let title=warning?'追高警告':missing?'数据暂不可核验':condition==='invalidated'?'信号失效':condition==='weakened'?'共识减弱':
    previous.condition==='warning'?'追高警告解除':previous.condition!=='qualified'?'共识恢复':state.votes<previous.votes||(ratioChanged&&state.holding!<previous.holding!)?'共识减弱':
    state.votes>previous.votes?(previous.votes<strongWallets&&state.votes>=strongWallets?'达到强共识':'共识增强'):'持仓状态更新';
  const pct=(v:number|null)=>v===null?'不可核验':`${(v*100).toFixed(0)}%`;
  const text=[`${missing?'⚠️':condition==='invalidated'?'🔴':'🔔'} ${title} ${signalShortId(view.signalId)}`,
    `有效票数：${previous.votes} → ${state.votes}`,
    `持仓保留率：${pct(previous.holding)} → ${pct(state.holding)}`,
    `原因：${reason?reasonLabel(reason):title}`,
    `评估时间：${utcTime(at)}`,'本提示关联首次信号；原始消息保持不变。'].join('\n');
  return {state,text,changed};
}
