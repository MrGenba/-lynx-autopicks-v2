'use strict';
async function notify({rest,send,owner},id,league,text,expiresAt=null){
 const payload={text,expires_at:expiresAt};
 if(!await rest('rpc/bk_claim_notification','POST',{p_id:id,p_league:league,p_payload:payload,p_owner:owner}))return false;
 try{const r=await send(league,text);if(r?.ok!==true||!Number.isSafeInteger(r.result?.message_id)||r.result.message_id<=0)throw Error('TELEGRAM_NOT_ACKNOWLEDGED');
  if(!await rest('rpc/bk_finish_notification','POST',{p_id:id,p_owner:owner,p_message_id:r.result.message_id}))throw Error('DELIVERY_RECEIPT_NOT_SAVED');return true;
 }catch(_){await rest('rpc/bk_finish_notification','POST',{p_id:id,p_owner:owner,p_message_id:null});return false;}
}
async function retryNotifications(ctx,now=new Date()){
 const rows=await ctx.rest('bk_notifications?sent_at=is.null&attempts=lt.5&order=created_at.asc&limit=20');let sent=0;
 for(const r of rows){if(r.payload.expires_at&&Date.parse(r.payload.expires_at)<=now.getTime())continue;
  if(await notify(ctx,r.notification_id,r.league,r.payload.text,r.payload.expires_at))sent++;}return sent;
}
module.exports={notify,retryNotifications};
