import { exploreResearch } from './exploration.js';
import type { Db } from '../store/db.js';
import { getKv } from '../store/db.js';
import { gapStatus } from '../backtest/features.js';
import { firstResearchSamples, latestResearchScope, type ResearchScope } from './report.js';
import { loadResearchConfig } from './config.js';
import type { Diagnostics } from './diagnostics.js';

export const RESEARCH_KEYBOARD = {inline_keyboard:[
  [{text:'摘要',callback_data:'research:summary'},{text:'拦截原因',callback_data:'research:blockers'}],
  [{text:'数据质量',callback_data:'research:quality'},{text:'参数比较',callback_data:'research:compare'},
   {text:'历史版本',callback_data:'research:history'}],
]};
function current(db:Db,now:number) {
  const scope=getKv<ResearchScope>(db,'active_research_scope')??latestResearchScope(db);
  const samples=scope?firstResearchSamples(db,scope):[];
  const rows=samples.map(s=>({s,d:s.diagnostics?JSON.parse(s.diagnostics) as Diagnostics:null}));
  const usable=rows.filter(({s,d})=>s.state==='ready'&&s.hasSnapshot&&d?.complete&&d.checks.gap?.status==='pass'
    &&d.windowStart!==undefined&&s.anchor_at!==null&&gapStatus(db,d.windowStart,s.anchor_at)==='clean');
  const mature=rows.filter(({s})=>(s.anchor_at??s.selected_at)+3600<=now);
  const outcomes=mature.filter(({s})=>s.state==='ready'&&s.outcomeState==='ready'&&s.ratio!==null&&Number.isFinite(s.ratio));
  const ready=samples.filter(s=>s.state==='ready').length;
  const blockers=new Map<string,number>(),quality=new Map<string,number>();
  for(const {s,d} of rows){
    if(s.state!=='ready')quality.set('基准价或快照不可用',(quality.get('基准价或快照不可用')??0)+1);
    for(const c of Object.values(d?.checks??{})) {
      if(c.status==='fail')blockers.set(c.label,(blockers.get(c.label)??0)+1);
      if(c.status==='unknown')quality.set(c.label+'无法核验',(quality.get(c.label+'无法核验')??0)+1);
    }
  }
  return {scope,samples,usable,mature,outcomes,ready,blockers,quality};
}
const top=(counts:Map<string,number>,limit=3)=>[...counts].sort((a,b)=>b[1]-a[1]).slice(0,limit).map(([k,v])=>`· ${k}：${v} 个`);
export function researchSummary(db:Db,now=Math.floor(Date.now()/1000)):string {
  const r=current(db,now),cfg=loadResearchConfig().config;
  const pct=(n:number,d:number)=>d?`${(n/d*100).toFixed(1)}%`:'暂无样本';
  return ['🔬 研究进度｜当前配置',`配置版本：${r.scope?.config_version??'暂无'}`,
    `调参状态：${r.usable.length<cfg.minIndependentTokens?'有效比较样本不足':r.ready/Math.max(1,r.samples.length)<cfg.baselineCoverage?'基准价覆盖不足':'需分方案检查训练与留出组，见参数比较'}`,
    `首次独立代币：${r.samples.length} 个`,
    `基准价完整：${r.ready}/${r.samples.length}（${pct(r.ready,r.samples.length)}；要求≥${cfg.baselineCoverage*100}%）`,
    `输入完整且无缺口：${r.usable.length} 个（独立样本最低 ${cfg.minIndependentTokens}）`,
    `1小时结果：${r.mature.length?`有效 ${r.outcomes.length}/已到期 ${r.mature.length}（${pct(r.outcomes.length,r.mature.length)}）`:'尚未到期'}`,
    `原规则完整合格：${r.usable.filter(x=>x.d?.eligible).length} 个`,
    '候选参数新增合格：按方案查看，不与原规则组混算', '',
    '主要拦截（可重叠）：',...(r.blockers.size?top(r.blockers):['暂无完整诊断']),
    '仅统计当前配置、规则及研究版本；按样本数量准入，无天数门槛。',
  ].join('\n');
}
export function researchDetails(db:Db,page?:string,now=Math.floor(Date.now()/1000)):string {
  if(!page||page==='summary')return researchSummary(db,now);
  const r=current(db,now);
  if(page==='blockers')return ['📋 当前版本拦截原因','每项为首次独立代币数；原因可重叠。',...top(r.blockers,30)].join('\n');
  if(page==='quality')return ['🔎 当前版本数据质量',`首次独立代币 ${r.samples.length}；输入完整且无缺口 ${r.usable.length}`,
    ...top(r.quality,30),'未知不等于不通过；未到期不等于缺失。'].join('\n');
  if(page==='history') {
    const versions=db.prepare('SELECT config_version,research_version,COUNT(*) n,COUNT(DISTINCT token) tokens FROM research_samples GROUP BY config_version,research_version ORDER BY MAX(id) DESC LIMIT 8').all() as {config_version:string;research_version:string;n:number;tokens:number}[];
    return ['🗃 历史版本（独立展示，不合并比较）',...versions.map(v=>`配置 ${v.config_version} · ${v.research_version}\n观察 ${v.n} 次 · 独立代币 ${v.tokens} 个`)].join('\n');
  }
  if(page==='compare') {
    if(!r.scope)return '🧪 参数比较：当前尚无样本。';
    const report=exploreResearch(db,loadResearchConfig().config,now,r.scope);
    return ['🧪 当前版本参数比较（探索诊断）',
      ...report.factors.filter(f=>f.planned).map(f=>{
        const kept=f.cohorts.reduce((n,c)=>n+(c.cells.find(x=>x.group==='retained')?.valid??0),0);
        const added=f.cohorts.reduce((n,c)=>n+c.added,0);
        return `${f.label} → ${typeof f.experiment.value==='boolean'?(f.experiment.value?'要求':'不要求'):f.experiment.value}\n新增完整合格 ${added} 个 · 保留组有效1小时 ${kept} 个\n训练准入：${f.registrationReady?'达到登记条件（尚不代表留出验证通过）':'未达标'}`;
      }), '各方案独立统计；不合并来源组判断准入。每格至少20个有效独立代币、到期1小时覆盖≥90%、基准价覆盖≥95%。',
      '以上为预设候选的只读诊断，不登记实验、不修改参数；完整验证仍需回放及留出结果。'].join('\n\n');
  }
  return '页面不存在，请返回研究摘要。';
}
