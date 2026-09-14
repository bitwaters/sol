import Database from 'better-sqlite3';
import { replayDelivery,type DeliveryExperiment } from '../research/delivery.js';
import { costReport,type CostScenario } from '../research/cost.js';
const [path,command,definition,transport='success',advance='0']=process.argv.slice(2);
if(!path||!definition||!['delivery','cost'].includes(command??''))throw new Error('Usage: research-replay.js DATABASE delivery|cost JSON_DEFINITION [success|429|unknown] [ADVANCE_SECONDS]');
const db=new Database(path,{readonly:true,fileMustExist:true});
try{
  if(command==='cost')console.log(JSON.stringify(costReport(db,JSON.parse(definition) as CostScenario),null,2));
  else{
    if(!['success','429','unknown'].includes(transport))throw new Error('invalid_transport');
    const row=db.prepare('SELECT id,frame FROM research_delivery_frames WHERE frame IS NOT NULL ORDER BY id DESC LIMIT 1').get() as {id:number;frame:Buffer}|undefined;
    if(!row)throw new Error('no_delivery_frame');
    console.log(JSON.stringify({frameId:row.id,...await replayDelivery(row.frame,JSON.parse(definition) as DeliveryExperiment,transport as 'success'|'429'|'unknown',Number(advance))},null,2));
  }
}finally{db.close();}
