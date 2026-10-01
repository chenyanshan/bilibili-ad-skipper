import test from 'node:test';import assert from 'node:assert/strict';
import {normalizeBody} from '../extension/core.js';
import {analyzeJev,planJev} from '../extension/jev-analysis.js';
const make=(count=300,seconds=2)=>normalizeBody(Array.from({length:count},(_,i)=>({from:i*seconds,to:(i+1)*seconds,content:'剧情与生活体验 '+i})));
function service(ads,{boundaryConfidence=.95,longProbability=.98}={}){
 const calls=[];const ask=async body=>{
  calls.push(body);const ids=body.state.eligible_subtitles.map(r=>r[0]);
  const ad=ads.find(([a,b])=>b>=ids[0]&&a<=ids.at(-1));
  if(body.questions.has_ad){const continuous=body.questions.has_ad.instructions.includes('proposed long ad interval');return {answers:{has_ad:{type:'noul',noul:continuous?longProbability:ad?.length?.98:.1}}};}
  if(body.state.confirmed_ad){const start=body.state.confirmed_ad.start/2;const choice=`s_${ids.find(id=>id===start)??ids.at(-1)}`;return {answers:{start:{type:'choice',choice,confidence:.95,probabilities:{[choice]:.95}},continuous:{type:'noul',noul:.99}}};}
  const choices=ad?[ad[0]<ids[0]?'outside':`s_${ad[0]}`,ad[1]>ids.at(-1)?'outside':`s_${ad[1]}`]:['none','none'];
  return {answers:Object.fromEntries(['start','end'].map((name,i)=>[name,{type:'choice',choice:choices[i],confidence:boundaryConfidence,probabilities:{[choices[i]]:boundaryConfidence}}]))};
 };return {ask,calls};
}
async function run(rows,api,extra={}){return analyzeJev({rows,model:'test',title:'测试',brands:'',threshold:.65,duration:rows.at(-1).to,ask:api.ask,...extra});}
test('没有关键词也检查全文并找到中段及片尾广告',async()=>{
 const rows=make(),api=service([[30,49],[275,289]]);const result=await run(rows,api);
 assert.deepEqual(result.segments.map(s=>[s.start,s.end]),[[60,100],[550,580]]);
 assert.equal(result.coverage.complete,true);assert.equal(result.stats.checkedRows,300);
});
test('无广告只发presence，覆盖全部行并可确认为no_ads',async()=>{
 const rows=make(900),api=service([]),result=await run(rows,api);
 assert.equal(result.analysisStatus,'no_ads');assert.equal(result.stats.actualRequests,planJev(rows).parts.length);
 assert.ok(api.calls.every(b=>Object.keys(b.questions).join()==='has_ad'));
 assert.equal(new Set(api.calls.flatMap(b=>b.state.eligible_subtitles.map(r=>r[0]))).size,900);
});
test('跨分块广告扩窗后使用完整边界，重叠结果去重',async()=>{
 const result=await run(make(320,1),service([[140,180]]));
 assert.equal(result.coverage.complete,true);assert.equal(result.segments.length,1);
 assert.equal(result.segments[0].start,140);assert.equal(result.segments[0].end,181);
 assert.equal(result.segments[0].autoSubmitEligible,false);
});
test('低边界置信度触发局部复核，复核不会增加自动投稿资格',async()=>{
 const api=service([[40,55]],{boundaryConfidence:.3}),result=await run(make(120),api);
 assert.equal(api.calls.filter(b=>b.questions.start&&!b.state.confirmed_ad).length,2);
 assert.equal(result.segments[0].boundaryReviewed,true);assert.equal(result.segments[0].autoSubmitEligible,false);
});
test('超过240秒的广告经连续推广复核后保留，失败则标记未完成',async()=>{
 for(const p of [.98,.2]){
  const api=service([[20,85]],{longProbability:p}),result=await run(make(150,4),api);
  assert.ok(api.calls.some(b=>b.questions.has_ad?.instructions.includes('proposed long ad interval')));
  if(p>.9){assert.equal(result.segments[0].end-result.segments[0].start,264);assert.equal(result.segments[0].longAdVerified,true);assert.equal(result.segments[0].autoSubmitEligible,false);}
  else{assert.equal(result.segments.length,0);assert.equal(result.analysisStatus,'incomplete');}
 }
});
test('请求预算耗尽不是无广告，可保留此前已确认的独立片段',async()=>{
 const result=await run(make(),service([[20,35],[200,215]]),{maxRequests:4});
 assert.equal(result.stats.actualRequests,4);assert.equal(result.budgetExhausted,true);assert.equal(result.analysisStatus,'incomplete');
 assert.equal(result.coverage.complete,false);assert.equal(result.segments.length,1);
 const empty=await run(make(900),service([]),{maxRequests:2});assert.equal(empty.analysisStatus,'incomplete');assert.ok(empty.stats.checkedRows<900);
});
test('HTTP错误、无效概率和边界矛盾不会伪装成无广告',async()=>{
 await assert.rejects(run(make(),{ask:async()=>{throw Error('HTTP 429');}}),/429/);
 await assert.rejects(run(make(),{ask:async()=>({answers:{has_ad:{type:'noul',noul:NaN}}})}),/有效广告/);
});
test('近乎整片的商业判断不会自动跳过整个视频',async()=>{
 const result=await run(make(100),service([[0,99]]));assert.equal(result.segments.length,0);assert.equal(result.analysisStatus,'incomplete');
});
test('矛盾边界缩小窗口重试，仍矛盾时不污染无广告缓存语义',async()=>{
 const normal=service([[20,30]]);let first=true;
 const ask=async b=>{if(b.questions.start&&first){first=false;return {answers:{start:{type:'choice',choice:'none',confidence:.9,probabilities:{none:.9}},end:{type:'choice',choice:'s_30',confidence:.9,probabilities:{s_30:.9}}}};}return normal.ask(b);};
 const result=await run(make(120),{ask});assert.equal(result.segments.length,1);assert.equal(result.segments[0].boundaryRepaired,true);assert.equal(result.analysisStatus,'ads');
 const broken=await run(make(20),{ask:async b=>b.questions.has_ad?{answers:{has_ad:{type:'noul',noul:.99}}}:{answers:{start:{type:'choice',choice:'none',confidence:.9,probabilities:{none:.9}},end:{type:'choice',choice:'none',confidence:.9,probabilities:{none:.9}}}}});
 assert.equal(broken.analysisStatus,'incomplete');assert.equal(broken.segments.length,0);
});
test('临界presence只触发小窗口复核，不以低于用户阈值的分数跳过',async()=>{
 const api=service([[20,30]]);const ask=async b=>{
  if(b.questions.has_ad&&b.state.eligible_subtitles.length>100)return {answers:{has_ad:{type:'noul',noul:.59}}};
  return api.ask(b);
 };
 const result=await run(make(120),{ask});assert.equal(result.segments.length,1);assert.ok(result.segments[0].confidence>=.65);
});

function prefixAnswer(choice,confidence=.95,continuous=.99){return {answers:{start:{type:'choice',choice,confidence,probabilities:{[choice]:confidence}},continuous:{type:'noul',noul:continuous}}};}
test('confident late start gets anchored prefix review; only start changes, no auto submission',async()=>{
 const api=service([[40,60]]),calls=[];
 const result=await run(make(120),{ask:async b=>{calls.push(b);return b.state.confirmed_ad?prefixAnswer('s_35'):b.questions.continuous?{answers:{continuous:{type:'noul',noul:.99}}}:api.ask(b);}});
 assert.equal(result.segments[0].start,70);assert.equal(result.segments[0].originalStart,80);assert.equal(result.segments[0].end,122);assert.equal(result.segments[0].autoSubmitEligible,false);
 const review=calls.find(b=>b.state.confirmed_ad);assert.ok(review.state.confirmed_ad.opening.length);assert.ok(review.state.eligible_subtitles.every(([id])=>id<=40));assert.equal(review.questions.end,undefined);assert.equal(result.stats.startReviews,1);
});
test('unconfirmed, unrelated, low-confidence or later prefix never expands confirmed ad',async()=>{
 for(const reply of [prefixAnswer('none'),prefixAnswer('s_41'),prefixAnswer('s_35',.8),prefixAnswer('s_35',.99,.3),{answers:{}}]){
 const api=service([[40,60]]),r=await run(make(120),{ask:b=>b.state.confirmed_ad||b.questions.continuous?reply:api.ask(b)});
 assert.equal(r.segments[0].start,80);assert.equal(r.segments[0].end,122);assert.equal(r.segments[0].autoSubmitEligible,false);assert.equal(r.segments[0].startReviewed,false);
 }
});
test('outside prefix expands once within 60s; repeated outside keeps original, no clipping',async()=>{
 for(const finish of [true,false]){let count=0;const api=service([[40,60]]);
 const r=await run(make(120),{ask:b=>b.state.confirmed_ad?(++count===2&&finish?prefixAnswer('s_15'):prefixAnswer('outside')):b.questions.continuous?{answers:{continuous:{type:'noul',noul:.99}}}:api.ask(b)});
 assert.equal(count,2);assert.equal(r.segments[0].start,finish?30:80);assert.equal(r.segments[0].end,122);assert.equal(r.segments[0].autoSubmitEligible,false);
 }
});
test('budget exhaustion at optional prefix review preserves confirmed ad and stays within limit',async()=>{
 const r=await run(make(120),service([[40,60]]),{maxRequests:3});assert.equal(r.stats.actualRequests,3);assert.equal(r.segments[0].start,80);assert.equal(r.budgetExhausted,true);assert.equal(r.segments[0].autoSubmitEligible,false);assert.equal(r.analysisStatus,'incomplete');
});
test('prefix review does not cross a previous independent confirmed ad',async()=>{
 const api=service([[25,35],[40,60]]),reviews=[];
 const r=await run(make(120),{ask:b=>{if(b.questions.continuous)return {answers:{continuous:{type:'noul',noul:.99}}};if(b.state.confirmed_ad){reviews.push(b);return prefixAnswer(`s_${b.state.eligible_subtitles[0][0]}`);}return api.ask(b);}});
 assert.equal(r.segments.length,2);assert.ok(r.segments[1].start>=r.segments[0].end);assert.ok(reviews[1].state.eligible_subtitles.every(([id])=>id>=36));
});
test('earlier start needs a separate continuity request anchored to explicit candidate',async()=>{
 const api=service([[40,60]]),calls=[];
 const r=await run(make(120),{ask:b=>{calls.push(b);if(b.state.confirmed_ad)return prefixAnswer('s_35');if(b.questions.continuous)return {answers:{continuous:{type:'noul',noul:.99}}};return api.ask(b);}});
 const pick=calls.findIndex(b=>b.state.confirmed_ad),confirm=calls.findIndex(b=>b.questions.continuous);
 assert.ok(confirm>pick);assert.deepEqual(Object.keys(calls[pick].questions),['start']);assert.equal(calls[confirm].state.proposed_start,70);assert.equal(calls[confirm].state.original_start,80);assert.ok(calls[confirm].state.eligible_subtitles.every(([id])=>id>=35&&id<40));assert.equal(r.segments[0].start,70);
});
test('budget ending between prefix selection and confirmation never accepts unverified expansion',async()=>{
 const api=service([[40,60]]);
 const r=await run(make(120),{ask:b=>b.state.confirmed_ad?prefixAnswer('s_35'):api.ask(b)},{maxRequests:4});
 assert.equal(r.stats.actualRequests,4);assert.equal(r.segments[0].start,80);assert.equal(r.segments[0].autoSubmitEligible,false);assert.equal(r.budgetExhausted,true);
});
