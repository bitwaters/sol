import type { Db } from '../store/db.js';
import type { PricePath } from './outcomes.js';
export interface CostScenario {notionalUsd:number;buySlippage:number;sellSlippage:number;buyFee:number;sellFee:number;networkUsd:number;}
export function costRatio(gross:number,c:CostScenario){
  if(!Number.isFinite(gross)||gross<0||!Number.isFinite(c.notionalUsd)||c.notionalUsd<=0||!Number.isFinite(c.networkUsd)||c.networkUsd<0
    ||[c.buySlippage,c.sellSlippage,c.buyFee,c.sellFee].some(v=>!Number.isFinite(v)||v<0||v>=1))throw new Error('invalid_cost_scenario');
  return (gross*(1-c.sellSlippage)*(1-c.sellFee)/(1+c.buySlippage))/(1+c.buyFee)-c.networkUsd/c.notionalUsd;
}
export function costReport(db:Db,c:CostScenario,horizon=3600){
  costRatio(1,c);
  if(![300,3600,86400].includes(horizon))throw new Error('invalid_horizon');
  const rows=db.prepare(`SELECT s.token,s.id,o.ratio,o.path FROM research_samples s LEFT JOIN research_outcomes o
    ON o.sample_id=s.id AND o.horizon=? AND o.state='ready' ORDER BY s.id`).all(horizon) as {token:string;id:number;ratio:number|null;path:string|null}[];
  const unique=[...new Map([...rows].reverse().map(r=>[r.token,r])).values()];
  const measured=unique.filter(r=>r.ratio!==null&&Number.isFinite(r.ratio));
  const values=measured.map(r=>costRatio(r.ratio!,c)).sort((a,b)=>a-b);
  const paths=measured.flatMap(r=>{const p=r.path?JSON.parse(r.path) as PricePath:null;return p?.complete?[p]:[];});
  const med=(a:number[])=>{const b=[...a].sort((a,b)=>a-b),i=Math.floor(b.length/2);return !b.length?null:b.length%2?b[i]!:(b[i-1]!+b[i]!)/2;};
  return {scenario:c,horizon,independentTokens:unique.length,valid:values.length,completePaths:paths.length,
    medianHypotheticalNetRatio:med(values),medianCloseDrawdown:med(paths.map(p=>p.maxCloseDrawdown!)),
    limitation:'全体首样本的成本情景描述；并非策略验证。固定期限按K线价格退出，滑点费用为输入假设；收盘路径不含蜡烛内极值，未模拟成交容量或可卖性。'};
}
