'use strict';
async function notify(ctx,id,league,text,expiresAt=null,extra={}){
 const {rest,send,owner}=ctx,review=require('./pregame_review');
 if(review.paused(ctx)&&review.lineupNotification(id,extra))return false;
 const payload={...extra,text,expires_at:expiresAt};
 if(!await rest('rpc/bk_claim_notification','POST',{p_id:id,p_league:league,p_payload:payload,p_owner:owner}))return false;
 try{const r=await send(league,text);if(r?.ok!==true||!Number.isSafeInteger(r.result?.message_id)||r.result.message_id<=0)throw Error('TELEGRAM_NOT_ACKNOWLEDGED');
  if(!await rest('rpc/bk_finish_notification','POST',{p_id:id,p_owner:owner,p_message_id:r.result.message_id}))throw Error('DELIVERY_RECEIPT_NOT_SAVED');return true;
 }catch(_){await rest('rpc/bk_finish_notification','POST',{p_id:id,p_owner:owner,p_message_id:null});return false;}
}
async function notifyReference(ctx,id,league,text,expiresAt=null,extra={}){
 const clock=ctx.referenceClock||Date.now,wait=ctx.referenceWait||(ms=>new Promise(resolve=>setTimeout(resolve,ms)));
 const send=async(...args)=>{
  ctx.referenceNotBefore||={};
  const rateKey=ctx.referenceRateKey||league;
  const delay=Math.max(0,(ctx.referenceNotBefore[rateKey]||0)-clock());
  if(delay)await wait(delay);
  if(expiresAt&&Date.parse(expiresAt)<=clock())return {ok:false};
  // Keep large comparisons below Telegram's per-chat/group message budget.
  ctx.referenceNotBefore[rateKey]=clock()+3100;
  return ctx.send(...args);
 };
 return notify({...ctx,send},id,league,text,expiresAt,extra);
}
async function retryNotifications(ctx,now=new Date()){
 const rows=await ctx.rest('bk_notifications?sent_at=is.null&attempts=lt.5&or=(payload->>kind.is.null,payload->>kind.neq.basketball_filtered_channel)&order=created_at.asc&limit=20');let sent=0;
 for(const r of rows){if(r.payload.expires_at&&Date.parse(r.payload.expires_at)<=now.getTime())continue;
  if(require('./pregame_review').paused(ctx)&&require('./pregame_review').lineupNotification(r.notification_id,r.payload))continue;
  if(r.payload.kind==='basketball_filtered_channel')continue;
  if(r.notification_id.startsWith('props:winamax.fr:'))continue; // Superseded by model-and-market previews.
  if(r.payload.kind==='basketball_value'&&(!ctx.canRetryValue||!await ctx.canRetryValue(r.payload,now)))continue;
  if((r.payload.kind==='basketball_lineup_reanalysis'||r.payload.lineup_key)&&(!ctx.canRetryReanalysis||!await ctx.canRetryReanalysis(r.payload,now)))continue;
  const deliver=r.payload.kind==='basketball_ps3838_reference'?notifyReference:notify;
  if(await deliver(ctx,r.notification_id,r.league,r.payload.text,r.payload.expires_at,r.payload))sent++;}return sent;
}
module.exports={notify,notifyReference,retryNotifications};

