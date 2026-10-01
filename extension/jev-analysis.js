import {budgetChunks,compactRows,mergeSegments,sponsorContext,touchesBoundary} from './core.js';
import {detectWithJev,jevRequest,jevBoundaryResult,JevBoundaryError,jevStartReviewRequest,jevStartReviewResult,jevStartContinuityRequest,jevStartContinuityConfirmed} from './providers.js';

class BudgetExceeded extends Error {}
// Leave room around each detection block for one larger boundary review.
export function planJev(rows) {
  const parts=budgetChunks(rows,4000,160,12);
  return {parts,stats:{mode:'jev-full-gated',totalRows:rows.length,selectedRows:rows.length,
    windows:parts.length,requests:parts.length,fullChars:JSON.stringify(compactRows(rows)).length,
    sentChars:0,actualRequests:0,promptTokens:0,completionTokens:0,usageReported:true,checkedRows:0}};
}

// The same orchestrator runs in the extension and in local real-API evaluations.
// Community boundaries are deliberately not an input.
export async function analyzeJev({rows,model,title,brands,threshold,duration,ask,onProgress=()=>{},maxRequests=24}) {
  const {parts,stats}=planJev(rows),context=sponsorContext(rows),found=[],positive=[];
  const checked=new Set();let incomplete=0,budgetExhausted=false;
  const input=part=>({rows:part,model,title,context,brands});
  async function request(body) {
    if(stats.actualRequests>=maxRequests)throw new BudgetExceeded();
    stats.actualRequests++;
    stats.sentChars+=JSON.stringify(body.state.eligible_subtitles).length;
    const reply=await ask(body);
    if(reply.usage){stats.promptTokens+=reply.usage.input_tokens||reply.usage.prompt_tokens||0;stats.completionTokens+=reply.usage.output_tokens||reply.usage.completion_tokens||0;}
    else stats.usageReported=false;
    return reply;
  }
  async function gate(part,continuous=false) {
    const body=jevRequest({...input(part),phase:'presence'});
    if(!continuous)body.questions.has_ad.instructions+=' Judge whether ANY embedded promotional passage exists, even when most of this range is ordinary content. A brief promotion inside a long story still counts. An explicit sponsorship disclosure or purchase link is not required when a brand-specific sales pitch is apparent.';
    if(continuous)body.questions.has_ad.instructions+=' This is a proposed long ad interval. Answer yes only if this entire eligible range is a continuous promotional pitch, including its immediate transitions, with no substantial return to ordinary content in the middle.';
    const reply=await request(body),answer=reply?.answers?.has_ad;
    if(answer?.type!=='noul'||typeof answer.noul!=='number'||!Number.isFinite(answer.noul)||answer.noul<0||answer.noul>1)throw Error('JEV 缺少有效广告判断，未执行跳过');
    return reply;
  }
  const fits=part=>part.length&&budgetChunks(part).length===1;
  const around=(start,end,padding)=>rows.filter(r=>r.to>start-padding&&r.from<end+padding);
  async function verifyLong(segment) {
    if(segment.end-segment.start>240){
      // Verify every block of a long interval, rather than silently discard it.
      const interval=rows.filter(r=>r.to>segment.start&&r.from<segment.end);
      for(const part of budgetChunks(interval,4000,160,12)){
        const confirmation=await gate(part,true);
        if(confirmation.answers.has_ad.noul<Math.max(.9,threshold)){incomplete++;return null;}
      }
      segment={...segment,longAdVerified:true,autoSubmitEligible:false};
    }
    return segment;
  }
  function accept(segment) {
    if(segment.truncated||segment.end<=segment.start||segment.end-segment.start>=duration*.95){incomplete++;return;}
    found.push(segment);
  }
  async function review(segment,part) {
    const edge=touchesBoundary(segment,part,rows);
    const needsReview=edge||segment.boundaryConfidence<.5;
    if(!needsReview)return [segment];
    const expanded=around(segment.start,segment.end,edge?60:20);
    if(!fits(expanded)){if(edge){incomplete++;return [];}return [{...segment,autoSubmitEligible:false}];}
    const reply=await request(jevRequest({...input(expanded),phase:'boundaries'}));
    const result=jevBoundaryResult({answers:{...reply.answers,has_ad:{type:'noul',noul:segment.confidence}}},expanded,threshold,duration);
    if(result.done||touchesBoundary(result.segment,expanded,rows)){incomplete++;return [];}
    // A review of one ad must not jump to an unrelated ad elsewhere in the context.
    if(result.segment.start>=segment.end||result.segment.end<=segment.start){incomplete++;return [];}
    return [{...result.segment,autoSubmitEligible:false,boundaryReviewed:true}];
  }
  async function reviewStart(segment,previousEnd=0) {
    // Review all confirmed ads, including confident boundaries. Bound total work
    // and keep the independently confirmed interval if prefix evidence is weak.
    const anchorRows=rows.filter(r=>r.to>segment.start&&r.from<Math.min(segment.end,segment.start+25)).slice(0,12);
    for(const padding of [30,60]){
      const prefix=rows.filter(r=>r.from>=Math.max(previousEnd,segment.start-padding)&&r.from<=segment.start);
      if(prefix.length<2||!fits(prefix))break;
      if(stats.actualRequests>=maxRequests){budgetExhausted=true;incomplete++;break;}
      stats.startReviews=(stats.startReviews||0)+1;
      const reply=await request(jevStartReviewRequest({...input(prefix),segment,anchorRows}));
      const result=jevStartReviewResult(reply,prefix,segment);
      if(result.status==='confirmed'){
        if(result.segment.start===segment.start)return result.segment;
        if(stats.actualRequests>=maxRequests){budgetExhausted=true;incomplete++;break;}
        const confirmation=await request(jevStartContinuityRequest({...input(prefix),segment,proposed:result.segment,anchorRows}));
        if(jevStartContinuityConfirmed(confirmation))return result.segment;
        break;
      }
      if(result.status!=='outside')break;
    }
    stats.unconfirmedStarts=(stats.unconfirmedStarts||0)+1;
    return {...segment,startReviewed:false,autoSubmitEligible:false};
  }
  async function locate(part,initialGate,retry=true) {
    try{
      const segments=await detectWithJev({...input(part),threshold,duration,ask:request,initialGate,repairInconsistent:true});
      for(const segment of segments)for(const reviewed of await review(segment,part))await accept(reviewed);
    }catch(error){
      if(!(error instanceof JevBoundaryError))throw error;
      if(!retry||part.length<24){incomplete++;return;}
      stats.boundaryRetries=(stats.boundaryRetries||0)+1;
      let confirmed=false;
      for(const sub of budgetChunks(part,2500,Math.ceil(part.length/2)+6,12)){
        const local=await gate(sub);
        if(local.answers.has_ad.noul>=threshold){confirmed=true;await locate(sub,local,false);}
      }
      if(!confirmed)incomplete++;
    }
  }
  try {
    // Presence checks cover all text, including blocks without local keywords.
    for(let i=0;i<parts.length;i++){
      await onProgress(`JEV 全文检查 ${i+1}/${parts.length}…`);
      const reply=await gate(parts[i]);
      for(const row of parts[i])checked.add(row.id);
      if(reply.answers.has_ad.noul>=threshold)positive.push({part:parts[i],gate:reply});
      else if(reply.answers.has_ad.noul>=.45&&parts[i].length>=24){
        // A short ad can be diluted by surrounding narrative. Recheck smaller
        // overlapping ranges; never turn the lower screening score into a skip.
        const size=Math.ceil(parts[i].length/2)+6;
        for(const sub of budgetChunks(parts[i],2500,size,12)){
          const local=await gate(sub);
          if(local.answers.has_ad.noul>=threshold)positive.push({part:sub,gate:local});
        }
      }
    }
    for(let i=0;i<positive.length;i++){
      const {part,gate:initialGate}=positive[i];
      await onProgress(`JEV 确认广告边界 ${i+1}/${positive.length}…`);
      await locate(part,initialGate);
    }
  }catch(error){
    if(!(error instanceof BudgetExceeded))throw error;
    budgetExhausted=true;incomplete++;
  }
  stats.checkedRows=checked.size;
  const merged=mergeSegments(found),segments=[];
  // Overlap merging can turn individually valid ads into an unsafe whole-video interval.
  for(const segment of merged){
    if(segment.end-segment.start>=duration*.95){incomplete++;continue;}
    try{
      const reviewed=await reviewStart(segment,segments.at(-1)?.end||0);
      if(reviewed.end-reviewed.start>=duration*.95){incomplete++;continue;}
      const verified=await verifyLong(reviewed);
      if(verified)segments.push(verified);
    }catch(error){
      if(!(error instanceof BudgetExceeded))throw error;
      budgetExhausted=true;incomplete++;
    }
  }
  const complete=!incomplete&&checked.size===rows.length;
  return {segments,stats,incomplete,budgetExhausted,
    analysisStatus:!complete?'incomplete':segments.length?'ads':'no_ads',
    coverage:{mode:stats.mode,complete,selectedRows:checked.size,totalRows:rows.length},
    ...(!complete?{message:budgetExhausted?'已达到本次请求预算，全文或广告边界尚未检查完；仅保留已确认片段。':'部分广告边界尚未确认，保留播放；可重新识别。'}:{})};
}
