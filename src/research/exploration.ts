import { gapStatus } from '../backtest/features.js';
import type { Db } from '../store/db.js';
import { getKv, setKv } from '../store/db.js';
import type { ResearchConfig } from './config.js';
import type { Diagnostics, RuleCheck } from './diagnostics.js';
import { firstResearchSamples, latestResearchScope, registerExperiment } from './report.js';
import type { Experiment } from './replay.js';

// Fixed before new observations: these are research alternatives, never production settings.
export const researchPlan: Array<{label:string;parameter:Experiment['parameter'];values:Array<number|boolean>;candidate:number|boolean}> = [
  {label:'有效票数',parameter:'validVotes',values:[2,3],candidate:2},
  {label:'观测净流入下限（美元）',parameter:'netInflow',values:[500,1000,2000],candidate:1000},
  {label:'代币年龄上限（分钟）',parameter:'ageMax',values:[360,720,1440],candidate:720},
  {label:'必须包含聪明钱',parameter:'requireSmartMoney',values:[true,false],candidate:false},
];
/** These four scalar factors change only thresholds of recorded independent checks.
 * Full replay remains the authority for a final comparison. No input, wallet, or price is backfilled. */
export function classifyThreshold(d:Diagnostics,e:Experiment) {
  const checks:Record<string,RuleCheck>=structuredClone(d.checks);
  const bound=(key:string,field:'min'|'max',value:number)=>{
    const c=checks[key];if(!c)throw new Error('missing_research_check');
    c[field]=value;
    c.status=c.value===null||typeof c.value!=='number'?'unknown':
      (c.min!=null&&c.value<c.min)||(c.max!=null&&c.value>c.max)?'fail':'pass';
  };
  if(e.parameter==='requireSmartMoney') {
    if(typeof e.value!=='boolean')throw new Error('invalid_threshold');
    if(e.value)bound('smartMoneyVotes','min',1);else checks.smartMoneyVotes={...checks.smartMoneyVotes!,status:'na'};
  } else {
    if(typeof e.value!=='number'||!Number.isFinite(e.value))throw new Error('invalid_threshold');
    if(e.parameter==='validVotes'){bound('rawVotes','min',e.value);bound('validVotes','min',e.value);}
    else if(e.parameter==='netInflow')bound('netInflow','min',e.value);
    else if(e.parameter==='ageMax')bound('ageMinutes','max',e.value);
    else throw new Error('unsupported_threshold');
  }
  const keys=e.parameter==='validVotes'?['rawVotes','validVotes']:e.parameter==='netInflow'?['netInflow']:e.parameter==='ageMax'?['ageMinutes']:['smartMoneyVotes'];
  const passes=(c:RuleCheck)=>c.status==='pass'||c.status==='na';
  return {eligible:Object.values(checks).every(passes),factorPass:keys.every(k=>passes(checks[k]!)),
    otherFailures:Object.entries(checks).filter(([k,c])=>!keys.includes(k)&&!passes(c)).map(([k])=>k)};
}
export function exploreResearch(db:Db,config:ResearchConfig,now=Math.floor(Date.now()/1000)) {
  const scope=latestResearchScope(db),first=firstResearchSamples(db,scope);
  const globalCoverage=first.length?first.filter(s=>s.state==='ready').length/first.length:0;
  const rows=first.map(s=>({s,d:s.diagnostics?JSON.parse(s.diagnostics) as Diagnostics:null}));
  const groups=[...new Set(rows.map(r=>r.d?.sources.join(',')??'unknown'))];
  const factors=researchPlan.flatMap(plan=>plan.values.map(value=>{
    const experiment:Experiment={parameter:plan.parameter,value};
    const cohorts=groups.map(source=>{
      const selected=rows.filter(r=>(r.d?.sources.join(',')??'unknown')===source);
      const available=selected.filter((r):r is {s:typeof r.s;d:Diagnostics}=>!!r.d&&r.s.hasSnapshot===1&&r.s.state==='ready'&&r.d.complete&&
        r.d.checks.gap?.status==='pass'&&r.s.anchor_at!==null&&
        // The stored gap rule uses the production window, frozen at capture. Window experiments use full replay.
        r.d.windowStart!==undefined&&gapStatus(db,r.d.windowStart,r.s.anchor_at)==='clean');
      const classified=available.map(r=>({...r,next:classifyThreshold(r.d,experiment)}));
      const remainingBlockers:Record<string,{label:string;count:number}>={};
      const blockerCombinations = new Map<string,{labels:string[];count:number}>();
      for(const r of classified.filter(r=>r.next.factorPass&&!r.next.eligible))for(const key of r.next.otherFailures){
        const blocker=remainingBlockers[key]??{label:r.d.checks[key]?.label??key,count:0};blocker.count++;remainingBlockers[key]=blocker;
      }
      for (const r of classified.filter(r=>r.next.factorPass&&!r.next.eligible)) {
        const keys = [...r.next.otherFailures].sort(), key = JSON.stringify(keys);
        const item = blockerCombinations.get(key) ?? {labels:keys.map(k=>r.d.checks[k]?.label??k),count:0};
        item.count++; blockerCombinations.set(key,item);
      }
      const cells=['retained','changed'].map(group=>{
        const matching=classified.filter(r=>group==='retained'?r.d.eligible&&r.next.eligible:r.d.eligible!==r.next.eligible);
        const mature=matching.filter(r=>r.s.anchor_at!+3600<=now);
        const valid=mature.filter(r=>r.s.outcomeState==='ready'&&r.s.ratio!==null&&Number.isFinite(r.s.ratio));
        return {group,selected:matching.length,mature:mature.length,valid:valid.length,coverage:mature.length?valid.length/mature.length:0};
      });
      const baselineCoverage=selected.length?selected.filter(r=>r.s.state==='ready').length/selected.length:0;
      return {source,selected:selected.length,inputComplete:available.length,baselineCoverage,
        factorPass:classified.filter(r=>r.next.factorPass).length,fullPass:classified.filter(r=>r.next.eligible).length,
        added:classified.filter(r=>!r.d.eligible&&r.next.eligible).length,cells,remainingBlockers,
        blockerCombinations:[...blockerCombinations.values()].sort((a,b)=>b.count-a.count),
        trainingReady:baselineCoverage>=config.baselineCoverage&&cells.every(c=>c.valid>=config.minPerCell&&c.coverage>=config.outcomeCoverage)
          &&cells.reduce((n,c)=>n+c.valid,0)>=config.minIndependentTokens};
    });
    return {label:plan.label,experiment,planned:value===plan.candidate,cohorts,
      registrationReady:globalCoverage>=config.baselineCoverage&&cohorts.some(c=>c.trainingReady)};
  }));
  const walletAttribution={observations:0,behaviorOnly:0,dataOnly:0,both:0,clear:0,legacy:0,
    behaviorReasons:{} as Record<string,number>,dataReasons:{} as Record<string,number>};
  for(const {d} of rows)for(const w of d?.wallets??[]){
    walletAttribution.observations++;
    if(!w.behaviorReasons||!w.dataReasons){walletAttribution.legacy++;continue;}
    const behavior=w.behaviorReasons.length>0,data=w.dataReasons.length>0;
    walletAttribution[behavior&&data?'both':behavior?'behaviorOnly':data?'dataOnly':'clear']++;
    for(const category of ['behaviorReasons','dataReasons'] as const)for(const reason of w[category]!)
      walletAttribution[category][reason]=(walletAttribution[category][reason]??0)+1;
  }
  return {scope,independentTokens:first.length,baselineCoverage:globalCoverage,factors,walletAttribution,
    registrations:db.prepare('SELECT id,created_at,definition,boundary_id,scope FROM research_experiments WHERE scope=?').all(JSON.stringify(scope)),
    limitation:'单项通过不代表完整入选；只做探索诊断，正式比较需完整回放和注册后的新代币留出验证；无天数门槛。'};
}
/** Register only once training exists; registering with zero training would make this experiment impossible to validate. */
export function advanceResearchExperiments(db:Db,config:ResearchConfig,now=Math.floor(Date.now()/1000)) {
  if(!config.enabled||now-(getKv<number>(db,'research_plan_checked_at')??0)<300)return [];
  const report=exploreResearch(db,config,now);
  const registered=report.factors.filter(f=>f.planned&&f.registrationReady).map(f=>registerExperiment(db,f.experiment,now));
  setKv(db,'research_plan_checked_at',now,now);
  return registered;
}
