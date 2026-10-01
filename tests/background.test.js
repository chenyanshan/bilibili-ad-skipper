import test from 'node:test';
import assert from 'node:assert/strict';
import {createBackground} from '../extension/background.js';
import {DEFAULTS} from '../extension/core.js';
const BVID='BV1JfLg6qEtf',KEY=BVID+':1',URL='https://www.bilibili.com/video/'+BVID;
const body=Array.from({length:100},(_,i)=>({from:i*3,to:i*3+3,content:'普通讲解字幕'+i}));
const reply=(value,status=200)=>({ok:status===200,status,json:async()=>value,text:async()=>JSON.stringify(value)});
function harness(options={}){
  const data={settings:{...DEFAULTS,jevApiKey:'fixture-credential',communityAutoSubmit:true,...options.settings},...options.data};
  const sessionData={};
  const changes=[],updates=[],requests=[],scripts=[],tabUrls=new Map([[1,URL],[2,URL]]),progress=[];
  let gates=0;
  const chromeApi={
    storage:{local:{get:async key=>key===null?structuredClone(data):{[key]:structuredClone(data[key])},set:async values=>Object.assign(data,structuredClone(values)),remove:async keys=>{for(const key of Array.isArray(keys)?keys:[keys])delete data[key];}},onChanged:{addListener:f=>changes.push(f)}},
    runtime:{getURL:p=>'chrome-extension://test/'+p,getManifest:()=>({version:'0.3.0'})},permissions:{contains:async()=>options.permission!==false},
    tabs:{get:async id=>({id,url:tabUrls.get(id)}),query:async()=>[],sendMessage:async(id,msg)=>progress.push({id,msg}),onUpdated:{addListener:f=>updates.push(f)},onRemoved:{addListener:()=>{}}},
    scripting:{executeScript:async({func,args,target})=>{scripts.push(func.name);if(func.name==='readMetadata')return [{result:{bvid:BVID,cid:123456,duration:options.duration||300,title:'测试视频'}}];if(func.name==='activateAiSubtitles')return [{result:{tracks:options.recoverSubtitles?[{lan:'ai-zh',subtitle_url:'https://test.hdslb.com/sub.json'}]:[],attempted:true}}];return [{result:options.noSubtitles?[]:[{lan:'zh-CN',subtitle_url:'https://test.hdslb.com/sub.json'}]}];}},
  };
  chromeApi.storage.session={get:async key=>({[key]:structuredClone(sessionData[key])}),set:async values=>Object.assign(sessionData,structuredClone(values)),remove:async key=>{delete sessionData[key];},setAccessLevel:async()=>{}};
  const fetch=async(url,init={})=>{
    const request={url,method:init.method||'GET',body:init.body?JSON.parse(init.body):null,headers:init.headers};requests.push(request);
    if(url.includes('www.bsbsb.top'))return options.community?options.community(request):reply([],404);
    if(url.includes('hdslb.com'))return reply({body:options.body||body});
    if(options.provider)return options.provider(request);
    if(request.body.state.confirmed_ad)return reply({answers:{start:{type:'choice',choice:'s_10',confidence:.95,probabilities:{s_10:.95}},continuous:{type:'noul',noul:.99}}});
    if(request.body.questions.has_ad){gates++;return reply({answers:{has_ad:{type:'noul',noul:gates%2?0.99:0.1}}});}
    return reply({answers:Object.fromEntries(['start','end'].map((key,i)=>{const choice=i?'s_19':'s_10';return [key,{type:'choice',choice,confidence:.95,probabilities:{[choice]:.96}}];}))});
  };
  let background=createBackground({chromeApi,fetch,now:()=>1000000});
  const restart=()=>{background=createBackground({chromeApi,fetch,now:()=>1000000});};
  const send=(msg,tabId=1)=>background.handle(msg,{tab:{id:tabId},url:tabUrls.get(tabId)});
  const analyze=(extra={},tab=1)=>send({type:'analyze',key:KEY,...extra},tab);
  const configure=patch=>{data.settings={...data.settings,...patch};for(const f of changes)f({settings:{newValue:data.settings}},'local');};
  const navigate=(tab=1,url=URL+'?p=2')=>{tabUrls.set(tab,url);for(const f of updates)f(tab,{url});};
  return {data,sessionData,requests,scripts,send,analyze,configure,navigate,chromeApi,restart};
}
const communityFound=()=>reply([{videoID:BVID,segments:[{cid:123456,category:'sponsor',actionType:'skip',segment:[5,15],UUID:'community-segment',videoDuration:300}]}]);
const aiRequests=h=>h.requests.filter(r=>r.url.includes('api.typesafe.ai')||r.url.includes('llm.example'));
const posts=h=>h.requests.filter(r=>r.url.includes('bsbsb.top')&&r.method==='POST');

test('社区广告先于Key、AI权限和字幕；force也不能绕过社区',async()=>{
  const h=harness({settings:{jevApiKey:'',provider:'llm',baseUrl:'',apiKey:''},permission:false,community:communityFound});
  for(const extra of [{},{force:true}]){
    const result=await h.analyze(extra);assert.equal(result.provider,'community');assert.equal(result.analysisStatus,'community');assert.equal(result.segments[0].source,'community');
  }
  assert.deepEqual(h.scripts,['readMetadata','readMetadata']);assert.equal(aiRequests(h).length,0);assert.equal(h.requests.filter(r=>r.url.includes('hdslb')).length,0);
});
test('无广告社区才识别AI；缓存稳定ID和JEV资格，不缓存Key或字幕',async()=>{
  const h=harness();const first=await h.analyze();assert.equal(first.analysisStatus,'ads');assert.equal(first.segments[0].autoSubmitEligible,true);
  assert.equal(first.community.status,'empty');assert.equal(first.segments[0].boundaryConfidence,.95);
  const calls=aiRequests(h).length;const second=await h.analyze();assert.equal(second.cached,true);assert.equal(second.segments[0].id,first.segments[0].id);assert.equal(aiRequests(h).length,calls);
  const cache=JSON.stringify(h.data['analysisCache:v9']);assert.ok(!cache.includes('fixture-credential'));assert.ok(!cache.includes('普通讲解字幕'));assert.match(cache,/jev-latest/);
});
test('完整无广告结果复用缓存',async()=>{
  const provider=async()=>reply({answers:{has_ad:{type:'noul',noul:.1}}});
  const h=harness({provider});assert.equal((await h.analyze()).analysisStatus,'no_ads');assert.equal((await h.analyze()).cached,true);assert.equal(aiRequests(h).length,1);
});
test('缺字幕、失败响应不会写入无广告缓存',async()=>{
  const missing=harness({noSubtitles:true});await assert.rejects(missing.analyze(),/字幕/);assert.equal(missing.data['analysisCache:v9'],undefined);
  const failed=harness({provider:async()=>reply({},500)});await assert.rejects(failed.analyze(),/HTTP 500/);assert.equal(failed.data['analysisCache:v9'],undefined);
});
test('两标签同视频同配置合并模型调用，结果各自具有可信registry',async()=>{
  const h=harness();const [a,b]=await Promise.all([h.analyze({},1),h.analyze({},2)]);
  assert.equal(a.segments[0].id,b.segments[0].id);assert.equal(aiRequests(h).length,4);assert.equal(h.scripts.filter(s=>s==='readSubtitles').length,1);
});
test('配置变化和导航期间的旧响应不缓存或应用',async()=>{
  for(const change of ['settings','navigation']){
    let release,entered;const started=new Promise(resolve=>entered=resolve);
    const h=harness({provider:async()=>{entered();return new Promise(resolve=>release=()=>resolve(reply({answers:{has_ad:{type:'noul',noul:.1}}})));}});
    const pending=h.analyze();await started;if(change==='settings')h.configure({jevModel:'new-model'});else h.navigate();release();
    await assert.rejects(pending,/切换|配置/);assert.equal(h.data['analysisCache:v9'],undefined);
  }
});
test('auto仅使用后台原区间，社区强制复核后投稿；重复skipped不重复POST',async()=>{
  let getCount=0;const h=harness({community:r=>r.method==='POST'?reply([{UUID:'server-receipt'}]):(getCount++,reply([],404))});
  const result=await h.analyze(),segment=result.segments[0];assert.equal(posts(h).length,0);
  const answer=await h.send({type:'skipped',key:KEY,segmentId:segment.id,start:0,end:300,confidence:1});
  assert.equal(answer.status,'submitted');assert.equal(getCount,2);assert.deepEqual(posts(h)[0].body.segments[0].segment,[30,60]);
  await h.send({type:'skipped',key:KEY,segmentId:segment.id});assert.equal(posts(h).length,1);assert.ok(!JSON.stringify(posts(h)).includes('fixture-credential'));
});
test('社区不可用保留原AI本地能力，但auto禁止，manual须重新查到empty',async()=>{
  let available=false;const h=harness({community:r=>r.method==='POST'?reply([{UUID:'manual-receipt'}]):reply([],available?404:503)});
  const result=await h.analyze(),id=result.segments[0].id;assert.equal(result.community.status,'unavailable');assert.equal(result.segments.length,1);
  assert.equal((await h.send({type:'skipped',key:KEY,segmentId:id})).status,'blocked');
  assert.equal((await h.send({type:'submit',key:KEY,segmentId:id})).status,'blocked');available=true;
  assert.equal((await h.send({type:'submit',key:KEY,segmentId:id})).status,'submitted');assert.equal(posts(h).length,1);
});
test('auto开关/禁用/未知id/跨视频不能借可信候选发帖',async()=>{
  const h=harness({settings:{communityAutoSubmit:false}}),result=await h.analyze(),id=result.segments[0].id;
  assert.equal((await h.send({type:'skipped',key:KEY,segmentId:id})).status,'blocked');
  assert.equal((await h.send({type:'submit',key:KEY,segmentId:'forged'})).status,'blocked');
  h.configure({enabled:false});assert.equal((await h.send({type:'submit',key:KEY,segmentId:id})).status,'blocked');assert.equal(posts(h).length,0);
});
test('强制复核发现社区晚到，不上传AI候选',async()=>{
  let count=0;const h=harness({community:()=>++count===1?reply([],404):communityFound()});const result=await h.analyze();
  assert.equal((await h.send({type:'skipped',key:KEY,segmentId:result.segments[0].id})).status,'duplicate');assert.equal(posts(h).length,0);
});
test('社区复核等待中切换视频，POST前guard再次撤销授权',async()=>{
  let count=0,release,entered;const started=new Promise(resolve=>entered=resolve);
  const h=harness({community:()=>{if(++count===1)return reply([],404);entered();return new Promise(resolve=>release=()=>resolve(reply([],404)));}});
  const result=await h.analyze();const pending=h.send({type:'skipped',key:KEY,segmentId:result.segments[0].id});await started;h.navigate();release();
  assert.equal((await pending).status,'blocked');assert.equal(posts(h).length,0);
});
test('旧版缓存移除，过期项清理，完成缓存最多100项',async()=>{
  const h=harness({data:{'cache:v6:old':{result:{segments:[]}},'analysisCache:v9':Array.from({length:102},(_,i)=>({id:'old-'+i,time:999999,result:{analysisStatus:'no_ads',coverage:{complete:true},segments:[]}}))}});
  await h.analyze();assert.equal(h.data['cache:v6:old'],undefined);assert.equal(h.data['analysisCache:v9'].length,100);
});

test('无Key且社区为空给可操作状态，不请求字幕；同BV/P追踪参数不撤销registry',async()=>{
 const missing=harness({settings:{jevApiKey:''}});const result=await missing.analyze();assert.equal(result.analysisStatus,'incomplete');assert.match(result.message,/配置 AI/);assert.deepEqual(missing.scripts,['readMetadata']);
 const h=harness({community:r=>r.method==='POST'?reply([{UUID:'valid-receipt'}]):reply([],404)});
 const analyzed=await h.analyze();h.navigate(1,URL+'?tracking=changed');
 assert.equal((await h.send({type:'submit',key:KEY,segmentId:analyzed.segments[0].id})).status,'submitted');
});

test('社区复核等待中用户保留/撤销，可信标志在POST前取消auto；明确manual仍可提交',async()=>{
 let count=0,release,entered;const started=new Promise(resolve=>entered=resolve);
 const h=harness({community:r=>{
  if(r.method==='POST')return reply([{UUID:'manual-after-retain'}]);
  if(++count===2){entered();return new Promise(resolve=>release=()=>resolve(reply([],404)));}
  return reply([],404);
 }});
 const result=await h.analyze(),id=result.segments[0].id;
 const pending=h.send({type:'skipped',key:KEY,segmentId:id});await started;
 assert.equal((await h.send({type:'retain',key:KEY,segmentId:id})).status,'retained');release();
 assert.equal((await pending).status,'blocked');assert.equal(posts(h).length,0);
 assert.equal((await h.send({type:'submit',key:KEY,segmentId:id})).status,'submitted');assert.equal(posts(h).length,1);
});

test('JEV presence与none边界矛盾不写no_ads缓存',async()=>{
 const h=harness({provider:async request=>request.body.questions.has_ad?reply({answers:{has_ad:{type:'noul',noul:.99}}}):reply({answers:{
  start:{type:'choice',choice:'none',confidence:.99,probabilities:{none:.99}},end:{type:'choice',choice:'none',confidence:.99,probabilities:{none:.99}},
 }})});
 const result=await h.analyze();assert.equal(result.analysisStatus,'incomplete');assert.equal(result.segments.length,0);assert.equal(h.data['analysisCache:v9'],undefined);
});

test('同视频force失败后原可信AI候选仍可明确手动投稿',async()=>{
 let fail=false;
 const h=harness({community:r=>r.method==='POST'?reply([{UUID:'retained-receipt'}]):reply([],404)});
 const result=await h.analyze();h.chromeApi.scripting.executeScript=async()=>{if(fail)throw Error('metadata failed');};fail=true;
 await assert.rejects(h.analyze({force:true}),/metadata failed/);
 assert.equal((await h.send({type:'submit',key:KEY,segmentId:result.segments[0].id})).status,'submitted');
});
test('社区显式关闭与网络不可用区分，缺Key说明如何启用',async()=>{
 const h=harness({settings:{communityEnabled:false,jevApiKey:''}});const result=await h.analyze();
 assert.equal(result.community.status,'disabled');assert.match(result.message,/已关闭/);assert.equal(h.requests.length,0);
});
test('被范围校验拒绝的JEV候选不缓存为no_ads',async()=>{
 let gate=0;
 const jev=harness({provider:async r=>r.body.questions.has_ad?reply({answers:{has_ad:{type:'noul',noul:++gate===1?.99:.1}}}):reply({answers:{start:{type:'choice',choice:'s_0',confidence:.99,probabilities:{s_0:.99}},end:{type:'choice',choice:'s_98',confidence:.99,probabilities:{s_98:.99}}}})});
 assert.equal((await jev.analyze()).analysisStatus,'incomplete');assert.equal(jev.data['analysisCache:v9'],undefined);
});

test('本机自定义端口的权限模式与设置页一致，不含端口',async()=>{
 const h=harness({settings:{jevBaseUrl:'http://localhost:8088'}});let origins;
 h.chromeApi.permissions.contains=async request=>{origins=request.origins;return true;};
 await h.analyze();assert.deepEqual(origins,['http://localhost/*']);
});
test('MV3 worker重启从trusted session恢复原候选，不重调AI即可自动或手动投稿',async()=>{
 for(const type of ['skipped','submit']){
  const h=harness({community:r=>r.method==='POST'?reply([{UUID:'restart-receipt'}]):reply([],404)});
  const result=await h.analyze(),calls=aiRequests(h).length,scripts=h.scripts.length;
  assert.ok(h.sessionData['trustedTabs:v3'].length===1);assert.ok(!JSON.stringify(h.sessionData).includes('fixture-credential'));
  h.restart();assert.equal((await h.send({type,key:KEY,segmentId:result.segments[0].id})).status,'submitted');
  assert.equal(aiRequests(h).length,calls);assert.equal(h.scripts.length,scripts);assert.equal(posts(h).length,1);
 }
});
test('worker重启不会用配置已改变、不同tab或不同BV/P的可信快照',async()=>{
 for(const change of ['settings','tab','video']){
  const h=harness(),result=await h.analyze();
  if(change==='settings')h.data.settings.jevApiKey='another-fixture-credential';
  if(change==='video')h.navigate();
  h.restart();assert.equal((await h.send({type:'submit',key:KEY,segmentId:result.segments[0].id},change==='tab'?2:1)).status,'blocked');
  assert.equal(posts(h).length,0);
 }
});
test('worker重启保留用户retain标志，禁止自动但允许明确手工投稿',async()=>{
 const h=harness({community:r=>r.method==='POST'?reply([{UUID:'retained-restart'}]):reply([],404)}),result=await h.analyze(),id=result.segments[0].id;
 await h.send({type:'retain',key:KEY,segmentId:id});h.restart();
 assert.equal((await h.send({type:'skipped',key:KEY,segmentId:id})).status,'blocked');assert.equal(posts(h).length,0);
 assert.equal((await h.send({type:'submit',key:KEY,segmentId:id})).status,'submitted');
});
test('worker重启保留自动尝试标志，不恢复in-flight死锁，失败后允许手动重试',async()=>{
 let fail=true;const h=harness({community:r=>r.method==='POST'?(fail?reply({},503):reply([{UUID:'retried-restart'}])):reply([],404)});
 const result=await h.analyze(),id=result.segments[0].id;
 assert.equal((await h.send({type:'skipped',key:KEY,segmentId:id})).status,'error');h.restart();
 assert.equal((await h.send({type:'skipped',key:KEY,segmentId:id})).status,'blocked');assert.equal(posts(h).length,1);
 fail=false;assert.equal((await h.send({type:'submit',key:KEY,segmentId:id})).status,'submitted');assert.equal(posts(h).length,2);
});
test('可信session快照数量有界且配置事件清除旧记录',async()=>{
 const h=harness();await h.analyze();const template=h.sessionData['trustedTabs:v3'][0];
 h.sessionData['trustedTabs:v3']=Array.from({length:110},(_,i)=>({...template,tabId:i+10}));
 await h.analyze();assert.equal(h.sessionData['trustedTabs:v3'].length,100);
 h.configure({jevModel:'changed-model'});h.restart();
 assert.equal((await h.send({type:'submit',key:KEY,segmentId:template.result.segments[0].id})).status,'blocked');
});

test('restoreToken等待中配置变化不能以旧配置创建新revision分析',async()=>{
 const h=harness();let release,entered;const started=new Promise(resolve=>entered=resolve);
 const get=h.chromeApi.storage.session.get;
 h.chromeApi.storage.session.get=async key=>{entered();await new Promise(resolve=>release=resolve);return get(key);};
 const pending=h.analyze();await started;h.configure({jevModel:'new-model'});release();
 await assert.rejects(pending,/配置已更新/);assert.equal(h.scripts.length,0);assert.equal(aiRequests(h).length,0);
});
test('tabs.get等待期间设置变化，current须在await后拒绝旧token',async()=>{
 const h=harness(),result=await h.analyze();let release,entered;const started=new Promise(resolve=>entered=resolve);
 const get=h.chromeApi.tabs.get;
 h.chromeApi.tabs.get=async id=>{entered();await new Promise(resolve=>release=resolve);return get(id);};
 const pending=h.send({type:'submit',key:KEY,segmentId:result.segments[0].id});await started;
 h.configure({jevModel:'new-model'});release();assert.equal((await pending).status,'blocked');assert.equal(posts(h).length,0);
});
test('allowed读取settings等待期间变更配置，不启动社区投稿复核',async()=>{
 const h=harness(),result=await h.analyze();let release,entered;const started=new Promise(resolve=>entered=resolve);
 const get=h.chromeApi.storage.local.get;let intercept=true;
 h.chromeApi.storage.local.get=async key=>{
  if(key==='settings'&&intercept){intercept=false;const old=await get(key);entered();await new Promise(resolve=>release=resolve);return old;}
  return get(key);
 };
 const lookupCount=h.requests.filter(r=>r.url.includes('bsbsb.top')).length;
 const pending=h.send({type:'submit',key:KEY,segmentId:result.segments[0].id});await started;
 h.configure({communityEnabled:false});release();assert.equal((await pending).status,'blocked');
 assert.equal(h.requests.filter(r=>r.url.includes('bsbsb.top')).length,lookupCount);assert.equal(posts(h).length,0);
});
test('JEV长视频始终检查全文；原有服务配置与省Token偏好不被改写',async()=>{
 for(const economy of [true,false]){
  const h=harness({settings:{economy,jevThreshold:.77,jevModel:'custom-model',apiKey:'retained-llm-key'},duration:900,provider:async()=>reply({answers:{has_ad:{type:'noul',noul:.1}}})});
  const before=structuredClone(h.data.settings),result=await h.analyze();
  assert.equal(result.analysisStatus,'no_ads');assert.equal(result.coverage.complete,true);assert.equal(result.coverage.mode,'jev-full-gated');assert.equal(aiRequests(h).length,1);
  assert.deepEqual(h.data.settings,before);
 }
});
test('旧算法缓存与会话不复用，新结果不混入v7边界',async()=>{
 const h=harness({data:{'analysisCache:v7':[{id:'old-result',result:{analysisStatus:'ads',segments:[{start:0,end:299}]}}]}});
 const result=await h.analyze();assert.equal(result.segments[0].start,30);assert.equal(h.data['analysisCache:v7'],undefined);assert.ok(h.data['analysisCache:v9']);
});
test('首次无字幕自动尝试AI字幕后继续识别，已有字幕不动开关',async()=>{
 const h=harness({noSubtitles:true,recoverSubtitles:true});const result=await h.analyze();assert.equal(result.provider,'jev');assert.equal(result.analysisStatus,'ads');assert.equal(h.scripts.filter(x=>x==='activateAiSubtitles').length,1);assert.ok(aiRequests(h).length>0);
 const direct=harness();await direct.analyze();assert.equal(direct.scripts.includes('activateAiSubtitles'),false);
});
test('恢复字幕失败不请求AI、不缓存、不再要求手动打开AI字幕',async()=>{
 const h=harness({noSubtitles:true});await assert.rejects(h.analyze(),e=>/已尝试自动获取字幕/.test(e.message)&&!/请在播放器/.test(e.message));assert.equal(h.scripts.filter(x=>x==='activateAiSubtitles').length,1);assert.equal(aiRequests(h).length,0);assert.equal(h.data['analysisCache:v9'],undefined);
});
test('社区有标注或未配置Key时，即便没有字幕也不操作字幕开关',async()=>{
 for(const h of [harness({noSubtitles:true,community:communityFound}),harness({noSubtitles:true,settings:{jevApiKey:''}})]){await h.analyze();assert.deepEqual(h.scripts,['readMetadata']);}
});
test('字幕尝试前发送进度时配置已变更，不再操作播放器',async()=>{
 const h=harness({noSubtitles:true,recoverSubtitles:true});
 h.chromeApi.tabs.sendMessage=async(id,msg)=>{if(msg.type==='progress'&&msg.text.includes('开启 AI 字幕'))h.configure({enabled:false});};
 await assert.rejects(h.analyze(),/配置|切换/);assert.equal(h.scripts.includes('activateAiSubtitles'),false);assert.equal(aiRequests(h).length,0);
});

test('旧 LLM 选择升级后只请求 JEV，无 JEV Key 时只用社区',async()=>{
 const h=harness({settings:{provider:'llm',apiKey:'legacy-secret',baseUrl:'https://llm.example'}});
 assert.equal((await h.analyze()).provider,'jev');assert.ok(aiRequests(h).every(r=>r.url.includes('api.typesafe.ai')&&r.headers.Authorization==='Bearer fixture-credential'));
 const empty=harness({settings:{provider:'llm',apiKey:'legacy-secret',jevApiKey:''}});assert.equal((await empty.analyze()).analysisStatus,'incomplete');assert.equal(aiRequests(empty).length,0);
});
test('用量只记录真实 JEV 请求；命中社区及缓存不累加',async()=>{
 const h=harness();await h.analyze();const entries=()=>Object.entries(h.data).filter(([k])=>k.startsWith('jevUsage:'));
 assert.equal(entries().length,1);const first=JSON.stringify(entries());await h.analyze();assert.equal(JSON.stringify(entries()),first);
 assert.equal(entries()[0][1].reduce((sum,r)=>sum+r.requests,0),aiRequests(h).length);assert.ok(!first.includes('fixture-credential'));
 const community=harness({community:communityFound});await community.analyze();assert.equal(Object.keys(community.data).filter(k=>k.startsWith('jevUsage:')).length,0);
});
test('视频页面不能读取统计或发起连接测试',async()=>{
 const h=harness();await assert.rejects(h.send({type:'usage'}),/未知/);await assert.rejects(h.send({type:'testConnection'}),/未知/);assert.equal(h.requests.length,0);
});

test('更新检查仅设置页可请求，不向视频页暴露更新操作',async()=>{
 const h=harness();await assert.rejects(h.send({type:'checkUpdate',force:true}),/未知请求/);assert.equal(h.requests.length,0);
});
