import { gapStatus } from '../backtest/features.js';
import { createHash } from 'node:crypto';
import type { Db } from '../store/db.js';
import { loadResearchConfig, type ResearchConfig } from './config.js';
import type { Diagnostics } from './diagnostics.js';
import { unpack } from './snapshot.js';
import { replay, variant, type Experiment } from './replay.js';

interface Sample {id:number;token:string;selected_at:number;anchor_at:number|null;stratum:number;probability:number;
  config_version:string;rules_version:string;research_version:string;state:string;baseline:string|null;
  frozen:Buffer|null;diagnostics:string|null;ratio:number|null;outcomeState:string|null;}
function samples(db:Db):Sample[]{return db.prepare(`SELECT s.id,s.token,s.selected_at,s.anchor_at,s.stratum,s.probability,s.config_version,s.rules_version,s.research_version,
  s.state,s.baseline,NULL frozen,s.diagnostics,o.ratio,o.state outcomeState FROM research_samples s
  LEFT JOIN research_outcomes o ON o.sample_id=s.id AND o.horizon=3600 ORDER BY s.selected_at,s.id`).all() as Sample[];}
function median(values:number[]){const a=[...values].sort((a,b)=>a-b),i=Math.floor(a.length/2);return !a.length?null:a.length%2?a[i]!:(a[i-1]!+a[i]!)/2;}
function weightedMedian(rows:{value:number;weight:number}[]){const sorted=[...rows].sort((a,b)=>a.value-b.value);let n=0;const half=sorted.reduce((s,r)=>s+r.weight,0)/2;
  for(const row of sorted){n+=row.weight;if(n>=half)return row.value;}return null;}
export function researchOverview(db:Db,now=Math.floor(Date.now()/1000)){
  const counts=db.prepare('SELECT state,COUNT(*) n FROM research_samples GROUP BY state').all();
  const strata=db.prepare('SELECT stratum,COUNT(*) samples,COUNT(DISTINCT token) tokens FROM research_samples GROUP BY stratum').all();
  const totals=db.prepare('SELECT COUNT(*) samples,COUNT(DISTINCT token) tokens FROM research_samples').get();
  const rules:Record<string,{label:string;pass:number;fail:number;unknown:number;na:number}>={},walletReasons:Record<string,number>={};
  for(const row of db.prepare('SELECT diagnostics FROM research_samples WHERE diagnostics IS NOT NULL').iterate() as Iterable<{diagnostics:string}>){
    const d=JSON.parse(row.diagnostics) as Diagnostics;
    for(const [key,check] of Object.entries(d.checks)){const r=rules[key]??{label:check.label,pass:0,fail:0,unknown:0,na:0};r[check.status]++;rules[key]=r;}
    for(const w of d.wallets)for(const reason of w.reasons)walletReasons[reason]=(walletReasons[reason]??0)+1;
  }
  const horizons=[300,3600,86400].map(horizon=>{
    const row=db.prepare(`SELECT COUNT(*) mature,SUM(CASE WHEN o.state='ready' THEN 1 ELSE 0 END) valid,
      COUNT(DISTINCT CASE WHEN o.state='ready' THEN s.token END) uniqueTokens
      FROM research_samples s LEFT JOIN research_outcomes o ON o.sample_id=s.id AND o.horizon=?
      WHERE COALESCE(s.anchor_at,s.selected_at)+?<=?`).get(horizon,horizon,now) as {mature:number;valid:number|null;uniqueTokens:number};
    return {horizon,...row,valid:row.valid??0,coverage:row.mature?(row.valid??0)/row.mature:null};
  });
  const selection=db.prepare('SELECT SUM(universe) universe,SUM(selected) selected FROM research_runs').get();
  const errors=db.prepare('SELECT error,COUNT(*) n FROM research_samples WHERE error IS NOT NULL GROUP BY error').all();
  const deliveryFrames=db.prepare('SELECT COUNT(*) total,SUM(CASE WHEN frame IS NOT NULL THEN 1 ELSE 0 END) available FROM research_delivery_frames').get();
  const storage=db.prepare('SELECT SUM(COALESCE(length(initial),0)+COALESCE(length(frozen),0)) bytes FROM research_samples').get();
  return {totals,counts,strata,selection,horizons,rules,walletReasons,errors,deliveryFrames,storage,
    scope:'仅已观测SOL交易；分层抽样、重复观察不等于独立代币；缺失与失败分开统计。'};
}
export function researchLines(db:Db):string[]{
  const r=researchOverview(db),total=r.totals as {samples:number;tokens:number};
  if(!total.samples)return ['🔬 宽范围研究：尚无样本（按样本数量准入，无天数门槛）'];
  return ['🔬 宽范围研究（独立于正式推送；无天数门槛）',`样本 ${total.samples} 条 / 独立代币 ${total.tokens} 个`,
    ...r.horizons.map(h=>`${h.horizon===300?'5分钟':h.horizon===3600?'1小时':'24小时'}：到期 ${h.mature} / 有效 ${h.valid}（${h.uniqueTokens}币）/ 覆盖 ${h.coverage===null?'—':(h.coverage*100).toFixed(0)+'%'}`),
    ...Object.values(r.rules).filter(v=>v.fail||v.unknown).map(v=>`· ${v.label}：未通过 ${v.fail} / 数据不足 ${v.unknown}`),
    ...Object.entries(r.walletReasons).map(([k,v])=>`· ${k}：${v} 次（可重叠）`)];
}
/** Persist a definition and a chronological boundary BEFORE future holdout observations exist. */
export function registerExperiment(db:Db,experiment:Experiment,now=Math.floor(Date.now()/1000)){
  const example=db.prepare('SELECT frozen FROM research_samples WHERE frozen IS NOT NULL ORDER BY id DESC LIMIT 1').get() as {frozen:Buffer}|undefined;
  if(!example)throw new Error('need_snapshot_before_registering');
  variant(unpack(example.frozen).config,experiment);
  const definition=JSON.stringify(experiment),id=createHash('sha256').update(`${now}:${definition}`).digest('hex').slice(0,16);
  const boundary=(db.prepare('SELECT COALESCE(MAX(id),0) n FROM research_samples').get() as {n:number}).n;
  db.prepare('INSERT INTO research_experiments(id,created_at,definition,boundary_id) VALUES (?,?,?,?)').run(id,now,definition,boundary);
  return {id,definition:experiment,boundary,holdout:'注册后新入选且此前未出现的代币'};
}
export function compareResearch(db:Db,experiment:Experiment,config:ResearchConfig=loadResearchConfig().config,now=Math.floor(Date.now()/1000),experimentId?:string){
  const all=samples(db);
  const registered=experimentId?db.prepare('SELECT * FROM research_experiments WHERE id=?').get(experimentId) as {definition:string;boundary_id:number}|undefined:undefined;
  if(experimentId&&!registered)throw new Error('experiment_not_found');
  if(registered&&registered.definition!==JSON.stringify(experiment))throw new Error('experiment_definition_changed');
  // First selection, including failed/missing ones, fixes each token's split and inclusion. No winner replacement.
  const unique=[...new Map([...all].reverse().map(r=>[r.token,r])).values()].sort((a,b)=>a.id-b.id);
  const boundary=registered?.boundary_id??unique[Math.max(0,Math.ceil(unique.length*.7)-1)]?.id??0;
  const cohorts=new Map<string,Sample[]>();
  for(const row of unique){
    const sources=row.diagnostics?(JSON.parse(row.diagnostics) as Diagnostics).sources.join(','):'unknown';
    const key=JSON.stringify([row.config_version,row.rules_version,row.research_version,sources]);
    const list=cohorts.get(key)??[];list.push(row);cohorts.set(key,list);
  }
  const reports=[...cohorts.entries()].map(([cohort,rows])=>{
    let unreplayable=0,unknown=0;
    const evaluated=rows.flatMap(row=>{
      if(!row.diagnostics||row.state!=='ready'){unknown++;return [];}
      const payload=db.prepare('SELECT frozen FROM research_samples WHERE id=?').get(row.id) as {frozen:Buffer|null};
      if(!payload.frozen){unknown++;return [];}
      const original=JSON.parse(row.diagnostics) as Diagnostics;
      try{
        const frozen=unpack(payload.frozen),next=replay(frozen,experiment);
        const changedConfig=variant(frozen.config,experiment);
        if(gapStatus(db,frozen.at-Math.max(frozen.config.signal.windowMinutes,changedConfig.signal.windowMinutes)*60,frozen.at)!=='clean'){unknown++;return [];}
        if(!original.complete||!next.complete||original.checks.gap?.status!=='pass'||next.checks.gap?.status!=='pass'){unknown++;return [];}
        const category=experiment.parameter==='warnPriceRatio'?'warn':experiment.parameter==='strongWallets'?'strong':null;
        const base=original.eligible&&(category?original[category]:true),alternative=next.eligible&&(category?next[category]:true);
        return [{row,base,alternative,group:base&&alternative?'retained':base!==alternative?'changed':'neither'}];
      }catch{unreplayable++;return [];}
    });
    const cells=['train','holdout'].flatMap(split=>['retained','changed'].map(group=>{
      const list=evaluated.filter(e=>(split==='train'?e.row.id<=boundary:e.row.id>boundary)&&e.group===group&&e.row.anchor_at!+3600<=now);
      const valid=list.filter(e=>e.row.outcomeState==='ready'&&e.row.ratio!==null&&Number.isFinite(e.row.ratio));
      return {split,group,mature:list.length,valid:valid.length,coverage:list.length?valid.length/list.length:0,
        median1h:median(valid.map(e=>e.row.ratio!)),weightedMedian1h:weightedMedian(valid.map(e=>({value:e.row.ratio!,weight:1/e.row.probability}))),
        added:list.filter(e=>!e.base&&e.alternative).length,removed:list.filter(e=>e.base&&!e.alternative).length};
    }));
    const baselineCoverage=rows.length?rows.filter(r=>r.state==='ready').length/rows.length:0;
    const validIndependent=evaluated.filter(e=>e.group!=='neither'&&e.row.anchor_at!+3600<=now&&e.row.outcomeState==='ready').length;
    const reasons:string[]=[];
    if(baselineCoverage<config.baselineCoverage)reasons.push('实时基准覆盖率不足');
    if(validIndependent<config.minIndependentTokens)reasons.push('有效独立代币不足');
    if(cells.some(c=>c.valid<config.minPerCell||c.coverage<config.outcomeCoverage))reasons.push('训练/留出保留组与变化组的样本数量或到期覆盖率不足');
    if(!registered)reasons.push('探索比较尚未预先注册，后续留出验证未开始');
    return {cohort,selected:rows.length,baselineCoverage,unreplayable,unknown,validIndependent,cells,ready:!reasons.length,reasons,
      classifications:{retained:evaluated.filter(e=>e.group==='retained').length,added:evaluated.filter(e=>!e.base&&e.alternative).length,
        removed:evaluated.filter(e=>e.base&&!e.alternative).length,neither:evaluated.filter(e=>e.group==='neither').length}};
  });
  const freshCoverage=unique.length?unique.filter(r=>r.state==='ready').length/unique.length:0;
  return {experiment,effect:experiment.parameter==='warnPriceRatio'?'警告分类':experiment.parameter==='strongWallets'?'强信号分类':'入选资格',experimentId:experimentId??null,ready:freshCoverage>=config.baselineCoverage&&reports.some(r=>r.ready),freshCoverage,boundary,cohorts:reports,
    gates:{minIndependentTokens:config.minIndependentTokens,minPerCell:config.minPerCell,baselineCoverage:config.baselineCoverage,outcomeCoverage:config.outcomeCoverage,minimumDays:null},
    limitation:'同一已观测候选时点的条件比较；按首次选择去重，概率权重仅描述抽样对象；无成交容量模型，不证明可实现收益。'};
}
