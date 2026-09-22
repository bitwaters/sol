import { getKv, setKv, type Db } from '../store/db.js';
import { stateMessage } from './updates.js';

export type ReplyKind = 'escalate' | 'exit_alert' | 'milestone';
export interface DeliveryFailure {taskId:number;signalId:number;kind:string;at:number;category:string;resolution?:string;}
export function replyBlocked(db:Db,signalId:number,kind:string):boolean {
  return !!getKv(db,`reply_block:${signalId}:${kind}`);
}
export function blockReply(db:Db,signalId:number,kind:string,taskId:number,at:number,category:string):void {
  setKv(db,`reply_block:${signalId}:${kind}`,{taskId,signalId,kind,at,category},at);
}
export function telegramFailureCategory(error:unknown):string {
  const message=error instanceof Error?error.message:'';
  if(/message to be replied (?:to )?not found|reply message not found/i.test(message))return 'original_missing';
  if(/message to edit not found|message (?:can.?t|cannot) be edited/i.test(message))return 'summary_uneditable';
  if(/forbidden|not enough rights|chat not found/i.test(message))return 'permission_or_chat';
  return 'request_failed';
}
export const failureLabels:Record<string,string>={original_missing:'被引用的原信号不存在或不可访问',
  summary_uneditable:'汇总卡片不存在或不可编辑',permission_or_chat:'频道访问或机器人权限异常',
  request_failed:'接口请求失败',delivery_unknown:'送达结果不明',rate_limited:'Telegram 限频'};

/** Resolve obsolete *definite* failures, never erase uncertain delivery evidence. */
export function reconcileReplyFailures(db:Db,now:number):void {
  const rows=db.prepare(`SELECT t.id,t.signal_id,t.kind,t.revision,s.message_revision,s.sent_at,s.status signal_status
    FROM push_tasks t LEFT JOIN signals s ON s.id=t.signal_id
    WHERE t.status='failed' AND t.kind IN ('escalate','exit_alert','milestone')`).all() as
    Array<{id:number;signal_id:number;kind:ReplyKind;revision:number;message_revision:number|null;sent_at:number|null;signal_status:string|null}>;
  db.transaction(()=>{
    for(const r of rows){
      const reason=r.signal_status!=='pushed'||r.sent_at===null||now-r.sent_at>86400?'monitoring_expired':
        r.kind==='escalate'&&r.revision!==r.message_revision?'superseded':null;
      if(!reason)continue;
      const key=`push_failure:${r.id}`,previous=getKv<DeliveryFailure>(db,key);
      setKv(db,key,{...previous,taskId:r.id,signalId:r.signal_id,kind:r.kind,at:previous?.at??now,
        category:previous?.category??'legacy_failure',resolution:reason},now);
      db.prepare("UPDATE push_tasks SET status='cancelled',next_retry_at=NULL,updated_at=? WHERE id=?").run(now,r.id);
    }
    // One-time upgrade: an exhausted legacy send can safely retry as an idempotent EDIT
    // only if a distinct, confirmed reply already exists. Never re-send an unconfirmed reply.
    if(getKv(db,'state_card_migration_v1'))return;
    const unknown=db.prepare(`SELECT id,signal_id FROM push_tasks WHERE kind='escalate'
      AND status='unknown' AND tg_message_id IS NULL AND attempts>=max_attempts`).all() as {id:number;signal_id:number}[];
    for(const task of unknown)if(!stateMessage(db,task.signal_id))
      blockReply(db,task.signal_id,'escalate',task.id,now,'delivery_unknown');
    const legacy=db.prepare(`SELECT id,signal_id FROM push_tasks WHERE kind='escalate'
      AND status='failed' AND attempts>=max_attempts`).all() as {id:number;signal_id:number}[];
    for(const task of legacy){
      const anchor=stateMessage(db,task.signal_id);
      if(!anchor||replyBlocked(db,task.signal_id,'escalate'))continue;
      setKv(db,`push_failure:${task.id}`,{taskId:task.id,signalId:task.signal_id,kind:'escalate',at:now,
        category:'legacy_failure',resolution:'retry_as_summary_edit'},now);
      db.prepare("UPDATE push_tasks SET status='pending',attempts=0,next_retry_at=NULL,tg_message_id=?,updated_at=? WHERE id=?")
        .run(anchor.messageId,now,task.id);
    }
    setKv(db,'state_card_migration_v1',true,now);
  })();
}
