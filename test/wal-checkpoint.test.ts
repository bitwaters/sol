import {expect,it} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openDatabase,getKv} from '../src/store/db.js';
import {startWalCheckpoint} from '../src/store/wal-checkpoint.js';
import {log} from './review-fixture.js';

it('checkpoints on a separate connection, preserves concurrent writes and restores automatic mode on stop',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'sol-wal-')),path=join(dir,'db'),db=openDatabase({path});
 const worker=startWalCheckpoint(db,path,log,20);
 try{
  expect(await worker.ready).toBe(true);expect(db.pragma('wal_autocheckpoint',{simple:true})).toBe(0);
  db.exec('CREATE TABLE checks(id INTEGER PRIMARY KEY,payload BLOB)');
  for(let i=0;i<40;i++){
   db.prepare('INSERT INTO checks VALUES (?,zeroblob(16384))').run(i);
   await new Promise(resolve=>setTimeout(resolve,2));
  }
  await new Promise(resolve=>setTimeout(resolve,100));
  expect(getKv(db,'wal_checkpoint')).toMatchObject({busy:0});
  expect(db.prepare('SELECT COUNT(*) n FROM checks').get()).toEqual({n:40});
  expect(db.pragma('quick_check',{simple:true})).toBe('ok');
 }finally{await worker.stop();expect(db.pragma('wal_autocheckpoint',{simple:true})).toBe(1000);db.close();rmSync(dir,{recursive:true,force:true});}
});
it('keeps automatic checkpoints if the worker cannot open the file',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'sol-wal-')),db=openDatabase({path:join(dir,'db')});
 const worker=startWalCheckpoint(db,join(dir,'missing'),log,20);
 try{expect(await worker.ready).toBe(false);expect(db.pragma('wal_autocheckpoint',{simple:true})).toBe(1000);expect(getKv(db,'wal_checkpoint_failed')).toBe(true);}
 finally{await worker.stop();db.close();rmSync(dir,{recursive:true,force:true});}
});
