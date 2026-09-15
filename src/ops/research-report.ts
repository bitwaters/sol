import Database from 'better-sqlite3';
import { compareResearch, researchOverview, registerExperiment } from '../research/report.js';
import { type Experiment, type Parameter, parameters } from '../research/replay.js';
import { loadResearchConfig } from '../research/config.js';
import { exploreResearch } from '../research/exploration.js';
const [path,command='overview',parameter,value,experimentId]=process.argv.slice(2);
if(!path||!['overview','explore','compare','register'].includes(command))throw new Error('Usage: research-report.js DATABASE overview|explore|compare|register [PARAMETER JSON_VALUE] [EXPERIMENT_ID]');
if(['compare','register'].includes(command)&&(!parameter||!Object.hasOwn(parameters,parameter)||value===undefined))throw new Error('Specify a supported parameter and JSON value');
const db=new Database(path,{readonly:command!=='register',fileMustExist:true});
try{
  const exp:Experiment={parameter:parameter as Parameter,value:value===undefined?0:JSON.parse(value)};
  const result=db.transaction(()=>command==='overview'?researchOverview(db):command==='explore'?exploreResearch(db,loadResearchConfig().config):command==='register'?registerExperiment(db,exp):compareResearch(db,exp,loadResearchConfig().config,undefined,experimentId))();
  console.log(JSON.stringify(result,null,2));
}finally{db.close();}
