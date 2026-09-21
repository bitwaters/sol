import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { setKv, type Db } from './db.js';
import type { Logger } from '../logger.js';
import { runtimeMetrics } from '../ops/metrics.js';

// PASSIVE checkpoints perform disk sync in this worker, never in the collection event loop.
const workerSource = `
const {parentPort,workerData}=require('node:worker_threads');
const Database=require(workerData.driver);
const db=new Database(workerData.path,{fileMustExist:true,timeout:0});
parentPort.on('message',()=>{
  const start=performance.now();
  try {const result=db.pragma('wal_checkpoint(PASSIVE)')[0];parentPort.postMessage({type:'done',duration:performance.now()-start,...result});}
  catch {parentPort.postMessage({type:'failed'});}
});
parentPort.postMessage({type:'ready'});
`;

export function startWalCheckpoint(db: Db, path: string, logger: Logger, intervalMs=5000): {
  ready: Promise<boolean>; stop: ()=>Promise<void>;
} {
  const old=db.pragma('wal_autocheckpoint',{simple:true}) as number;
  const version=(db.prepare('SELECT sqlite_version() v').get() as {v:string}).v.split('.').map(Number);
  // Only enable concurrent checkpoints on releases containing SQLite's WAL-reset fix.
  if ((version[0]??0)<3 || (version[0]===3 && ((version[1]??0)<51 || (version[1]===51&&(version[2]??0)<3)))) {
    logger.warn('SQLite 版本不支持后台检查点，保留自动检查点');
    return {ready:Promise.resolve(false),stop:async()=>{}};
  }
  let enabled=false,stopped=false,busy=false,started=0;
  let resolveReady!: (enabled:boolean)=>void;
  const ready=new Promise<boolean>(resolve=>{resolveReady=resolve;});
  const worker=new Worker(workerSource,{eval:true,workerData:{path,driver:createRequire(import.meta.url).resolve('better-sqlite3')}});
  const restore=()=>{if(db.open)db.pragma(`wal_autocheckpoint=${old}`);enabled=false;};
  const fail=()=>{
    if(stopped)return;
    stopped=true;clearInterval(timer);restore();resolveReady(false);
    if(db.open)setKv(db,'wal_checkpoint_failed',true);
    logger.error('后台数据库检查点失败，已恢复自动检查点');
    void worker.terminate();
  };
  const timer=setInterval(()=>{
    if(!enabled||stopped)return;
    if(busy){if(performance.now()-started>30000)fail();return;}
    busy=true;started=performance.now();worker.postMessage('checkpoint');
  },intervalMs);
  worker.on('message',(message:{type:string;duration:number;busy:number;log:number;checkpointed:number})=>{
    if(stopped)return;
    if(message.type==='ready'){
      db.pragma('wal_autocheckpoint=0');enabled=true;resolveReady(true);setKv(db,'wal_checkpoint_failed',false);
    }else if(message.type==='done'){
      busy=false;runtimeMetrics.observe('storage.wal_checkpoint',message.duration);
      setKv(db,'wal_checkpoint',{at:Math.floor(Date.now()/1000),busy:message.busy,logPages:message.log,checkpointedPages:message.checkpointed});
    }else fail();
  });
  worker.on('error',fail);worker.on('exit',()=>{if(!stopped)fail();});
  return {ready,stop:async()=>{stopped=true;clearInterval(timer);restore();resolveReady(false);await worker.terminate();}};
}
