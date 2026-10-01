import test from 'node:test';import assert from 'node:assert/strict';
import {DEFAULTS,normalizeBody} from '../extension/core.js';
import {jevEndpoint,providerConfig,jevRequest,jevBoundaryResult,detectWithJev,connectionProbe,validateProbe} from '../extension/providers.js';
const rows=normalizeBody(Array.from({length:60},(_,i)=>({from:i*3,to:i*3+3,content:`字幕 ${i}`})));
const answer=(start,end,p=.95)=>({answers:{has_ad:{type:'noul',noul:p},start:{type:'choice',choice:start,confidence:.7,probabilities:{[start]:.8}},end:{type:'choice',choice:end,confidence:.75,probabilities:{[end]:.85}}}});
test('JEV 地址支持根地址、v1 和完整端点，拒绝外部 HTTP',()=>{
 for(const base of ['https://api.typesafe.ai','https://api.typesafe.ai/v1/','https://api.typesafe.ai/v1/systemone'])assert.equal(jevEndpoint(base),'https://api.typesafe.ai/v1/systemone');
 assert.throws(()=>jevEndpoint('http://example.com'));assert.throws(()=>jevEndpoint('https://user:pass@example.com'));
});
test('旧 LLM 选择不再路由请求，只使用 JEV 配置',()=>{
 const s={...DEFAULTS,provider:'llm',baseUrl:'https://example.com/v1',model:'test-model',apiKey:'llm-test',jevApiKey:'jev-test'};
 assert.equal(providerConfig(s).key,'jev-test');assert.equal(providerConfig({...s,provider:'jev'}).key,'jev-test');
 assert.equal(providerConfig({...s,provider:'jev',jevApiKey:''}).key,'');assert.equal(providerConfig({...s,provider:'other'}).id,'jev');
 assert.equal(connectionProbe({...s,provider:'jev'}).model,'jev-latest');assert.ok(!('messages' in connectionProbe({...s,provider:'jev'})));
});
test('JEV 一次并行提问，选择含文本的边界，不依赖 question key',()=>{
 const body=jevRequest({model:'jev-latest',title:'视频',context:'',brands:'',rows});
 assert.deepEqual(Object.keys(body.questions),['has_ad','start','end']);assert.equal(body.questions.start.type,'choice');assert.match(body.questions.start.criteria.s_0,/Subtitle ID 0: 字幕 0/);assert.equal(Object.keys(body.questions.start.criteria).length,62);
 assert.ok(!('messages' in body));assert.throws(()=>jevRequest({rows:[...rows,...rows,...rows,...rows,...rows]}));
});
test('JEV 起止 ID 映射本机时间，概率与边界置信度分开',()=>{
 const r=jevBoundaryResult(answer('s_10','s_49'),rows,.65,180);assert.equal(r.segment.start,30);assert.equal(r.segment.end,150);assert.equal(r.segment.confidence,.95);assert.equal(r.segment.boundaryConfidence,.7);
});
test('JEV 多广告循环仅传未处理后缀，遇到无广告停止',async()=>{
 const sent=[];const results=[answer('s_3','s_12'),answer('s_3','s_12'),answer('s_30','s_40'),answer('s_30','s_40'),answer('none','none',.1)];
 const found=await detectWithJev({rows,model:'jev-latest',threshold:.65,duration:180,ask:async b=>{sent.push(b);return results.shift();}});
 assert.equal(found.length,2);assert.equal(sent[2].state.eligible_subtitles[0][0],13);assert.equal(sent[4].state.eligible_subtitles[0][0],41);assert.ok(sent[2].state.preceding_context.length<=4);
});
test('JEV 拒绝反向、越界、缺字段和不一致答案',()=>{
 assert.throws(()=>jevBoundaryResult(answer('s_20','s_10'),rows,.65,180));assert.throws(()=>jevBoundaryResult(answer('s_999','s_30'),rows,.65,180));assert.throws(()=>jevBoundaryResult(answer('none','s_30'),rows,.65,180));assert.throws(()=>jevBoundaryResult({},rows,.65,180));
 const a=answer('s_1','s_3');a.answers.has_ad.noul='0.95';assert.throws(()=>jevBoundaryResult(a,rows,.65,180));assert.throws(()=>validateProbe('jev',{answers:{ok:{noul:.9}}}));validateProbe('jev',{answers:{ok:{type:'noul',noul:.9}}});
});
test('JEV 超出窗口要求扩窗，不在相同窗口死循环',async()=>{
 let calls=0;const found=await detectWithJev({rows,threshold:.65,duration:300,ask:async()=>{calls++;return answer('s_10','outside');}});assert.equal(calls,2);assert.equal(found[0].end,180);
});
test('JEV 不返回无限循环的部分成功',async()=>{
 await assert.rejects(detectWithJev({rows,threshold:.65,duration:300,maxPasses:1,ask:async()=>answer('s_1','s_3')}),/上限/);
});

test('JEV 无广告只问一题，不列出全部边界选项',async()=>{let calls=0;const found=await detectWithJev({rows,threshold:.65,duration:180,ask:async body=>{calls++;assert.deepEqual(Object.keys(body.questions),['has_ad']);return {answers:{has_ad:{type:'noul',noul:.1}}};}});assert.equal(calls,1);assert.deepEqual(found,[]);});

test('分发默认配置：仅 JEV，Key 留空',()=>{assert.equal(DEFAULTS.provider,'jev');assert.ok(!('baseUrl' in DEFAULTS));assert.ok(!('model' in DEFAULTS));assert.ok(!('apiKey' in DEFAULTS));assert.equal(DEFAULTS.jevApiKey,'');});

test('自动投稿同时要求presence、两个边界confidence与选中概率达到90%，本地阈值不变',()=>{
 const good=answer('s_10','s_19',.9);
 for(const name of ['start','end']){good.answers[name].confidence=.9;good.answers[name].probabilities[good.answers[name].choice]=.9;}
 assert.equal(jevBoundaryResult(good,rows,.65,180).segment.autoSubmitEligible,true);
 const mutations=[a=>a.has_ad.noul=.89,a=>a.start.confidence=.89,a=>a.end.confidence=.89,
  a=>a.start.probabilities[a.start.choice]=.89,a=>a.end.probabilities[a.end.choice]=.89];
 for(const mutate of mutations){const changed=structuredClone(good);mutate(changed.answers);const result=jevBoundaryResult(changed,rows,.65,180);assert.ok(result.segment);assert.equal(result.segment.autoSubmitEligible,false);}
 const outside=structuredClone(good);outside.answers.end={type:'choice',choice:'outside',confidence:.99,probabilities:{outside:.99}};
 assert.equal(jevBoundaryResult(outside,rows,.65,300).segment.autoSubmitEligible,false);
});

test('presence为广告但两个边界均none不视作已确认无广告',()=>{
 assert.throws(()=>jevBoundaryResult(answer('none','none',.99),rows,.65,180),/矛盾|未完成/);
 assert.equal(jevBoundaryResult(answer('none','none',.1),rows,.65,180).done,true);
});
