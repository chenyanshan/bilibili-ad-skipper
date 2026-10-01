import {createUsageTracker} from './usage.js';
import {providerConfig,connectionProbe,validateProbe} from './providers.js';
import {analyzeJev} from './jev-analysis.js';
import {DEFAULTS,normalizeSettings,normalizeBody} from './core.js';
import {createCommunityClient} from './community.js';
import {readSubtitles,activateAiSubtitles} from './subtitles.js';

const CACHE_KEY='analysisCache:v8',CACHE_TTL=7*86400000,REGISTRY_KEY='trustedTabs:v2';
function videoKey(url){try{const u=new URL(url);return u.origin==='https://www.bilibili.com'&&/^\/video\/(BV[\w]+)/.test(u.pathname)?`${u.pathname.match(/\/video\/(BV[\w]+)/)[1]}:${Number(u.searchParams.get('p')||1)}`:null;}catch{return null;}}
function rank(lan){return ['zh-CN','zh-Hans','zh','ai-zh'].indexOf(lan)<0?10:['zh-CN','zh-Hans','zh','ai-zh'].indexOf(lan);}

// Metadata precedes community lookup. No subtitle/player request is needed for a community hit.
async function readMetadata(expected){
  const bvid=location.pathname.match(/\/video\/(BV[\w]+)/)?.[1];
  const page=Number(new URL(location.href).searchParams.get('p')||1);
  if(!bvid||`${bvid}:${page}`!==expected)throw Error('视频已切换，请重试');
  const r=await fetch('https://api.bilibili.com/x/web-interface/view?bvid='+bvid,{credentials:'include',signal:AbortSignal.timeout(15000)});
  const j=await r.json();if(j.code!==0)throw Error('无法读取 B站视频信息');
  const part=j.data?.pages?.find(p=>p.page===page);if(!part)throw Error('未找到当前分 P');
  return {bvid,cid:part.cid,title:j.data.title+' '+part.part,duration:part.duration};
}

export function createBackground({chromeApi=globalThis.chrome,fetch:fetchApi=globalThis.fetch,now=Date.now,communityClient}={}) {
  const storage=chromeApi.storage.local;
  const community=communityClient||createCommunityClient({fetch:fetchApi,storage,now,version:chromeApi.runtime.getManifest().version});
  const session=chromeApi.storage.session||storage;
  Promise.resolve(session.setAccessLevel?.({accessLevel:'TRUSTED_CONTEXTS'})).catch(()=>{});
  const tabs=new Map(),jobs=new Map();let revision=0,cacheQueue=Promise.resolve(),registryQueue=Promise.resolve();
  const settings=async()=>normalizeSettings((await storage.get('settings')).settings);
  const usage=createUsageTracker({storage,now});
  const serializeCache=task=>{const next=cacheQueue.then(task,task);cacheQueue=next.catch(()=>{});return next;};
  const serializeRegistry=task=>{const next=registryQueue.then(task,task);registryQueue=next.catch(()=>{});return next;};
  const settingsHash=s=>fingerprint(JSON.stringify(Object.keys(DEFAULTS).sort().map(key=>[key,s[key]])));
  async function registryRecords(){
    const saved=(await session.get(REGISTRY_KEY))[REGISTRY_KEY];
    return (Array.isArray(saved)?saved:[]).filter(record=>Number.isInteger(record?.tabId)&&typeof record.key==='string'&&
      typeof record.configHash==='string'&&record.result&&Array.isArray(record.result.segments)&&
      Number.isFinite(record.time)&&now()-record.time>=0&&now()-record.time<CACHE_TTL);
  }
  async function persistToken(token){
    if(!token.result)return;
    await serializeRegistry(async()=>{
      if(!await current(token))return;
      const records=(await registryRecords()).filter(record=>record.tabId!==token.tabId);
      const result=structuredClone(token.result);
      // A worker can terminate during a request. The attempt flag/ledger survive; a transient lock must not.
      for(const segment of result.segments)delete segment.submissionInFlight;
      if(!await current(token))return;
      records.push({tabId:token.tabId,key:token.key,configHash:token.configHash,time:now(),result});
      await session.set({[REGISTRY_KEY]:records.sort((a,b)=>b.time-a.time).slice(0,100)});
    });
  }
  async function restoreToken(tabId,key){
    if(tabs.has(tabId))return tabs.get(tabId);
    return serializeRegistry(async()=>{
      if(tabs.has(tabId))return tabs.get(tabId);
      const capturedRevision=revision;
      const record=(await registryRecords()).find(record=>record.tabId===tabId&&record.key===key);
      if(!record||record.configHash!==await settingsHash(await settings()))return undefined;
      const currentUrl=(await chromeApi.tabs.get(tabId)).url;
      if(capturedRevision!==revision||videoKey(currentUrl)!==key)return undefined;
      const token={tabId,key,revision,configHash:record.configHash,result:structuredClone(record.result)};
      tabs.set(tabId,token);return token;
    });
  }
  function forgetSnapshot(tabId,nextKey){
    return serializeRegistry(async()=>{
      const records=await registryRecords();
      await session.set({[REGISTRY_KEY]:records.filter(record=>record.tabId!==tabId||record.key===nextKey)});
    });
  }
  async function current(token){
    if(tabs.get(token.tabId)!==token||token.revision!==revision)return false;
    try{
      const tab=await chromeApi.tabs.get(token.tabId);
      return tabs.get(token.tabId)===token&&token.revision===revision&&videoKey(tab.url)===token.key;
    }catch{return false;}
  }
  async function ensure(token){if(!await current(token))throw Error('视频或配置已切换，请重新识别');}
  async function ensureJob(job){
    if(job.revision!==revision)throw Error('配置已更新，停止旧服务请求');
    for(const token of job.subscribers.values())if(await current(token))return token;
    throw Error('视频已切换，停止后续 AI 请求');
  }
  async function jsonFetch(url,options={}){
    const r=await fetchApi(url,{...options,redirect:'error',signal:AbortSignal.timeout(25000)});
    if(!r.ok)throw Error(`请求失败 HTTP ${r.status}`);return r.json();
  }
  async function execute(tabId,func,args){const [r]=await chromeApi.scripting.executeScript({target:{tabId},world:'MAIN',func,args});if(!r?.result)throw Error('读取播放器失败，请刷新 B站页面');return r.result;}
  function configIdentity(s,p){return JSON.stringify({version:8,provider:p.id,url:p.url,model:p.model,threshold:p.threshold,brandHints:s.brandHints});}
  async function fingerprint(value){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(x=>x.toString(16).padStart(2,'0')).join('');}
  async function cacheGet(id){return serializeCache(async()=>{
    const all=await storage.get(null),entries=Array.isArray(all[CACHE_KEY])?all[CACHE_KEY]:[];
    const valid=entries.filter(e=>e&&typeof e.id==='string'&&Number.isFinite(e.time)&&now()-e.time>=0&&now()-e.time<CACHE_TTL&&(e.result?.coverage?.complete===true||(e.result?.analysisStatus==='ads'&&e.result.incomplete===0))&&['ads','no_ads'].includes(e.result.analysisStatus)&&Array.isArray(e.result.segments)).sort((a,b)=>b.time-a.time).slice(0,100);
    const legacy=Object.keys(all).filter(k=>(k.startsWith('cache:')||(k.startsWith('analysisCache:')&&k!==CACHE_KEY)));if(legacy.length)await storage.remove(legacy);
    if(valid.length!==entries.length)await storage.set({[CACHE_KEY]:valid});
    return valid.find(e=>e.id===id)?.result;
  });}
  async function cachePut(id,result){if(!result.coverage.complete&&!(result.analysisStatus==='ads'&&result.incomplete===0))return;await serializeCache(async()=>{
    const stored=(await storage.get(CACHE_KEY))[CACHE_KEY];const entries=Array.isArray(stored)?stored:[];
    const retained=entries.filter(e=>e.id!==id&&Number.isFinite(e.time)&&now()-e.time>=0&&now()-e.time<CACHE_TTL);
    await storage.set({[CACHE_KEY]:[{id,time:now(),result},...retained].sort((a,b)=>b.time-a.time).slice(0,100)});
  });}
  async function runAi(job,s,provider,v){
    const token=await ensureJob(job);
    let tracks=(await execute(token.tabId,readSubtitles,[job.key,v])).filter(t=>t.subtitle_url);
    if(!tracks.length){
      const currentToken=await ensureJob(job);
      await chromeApi.tabs.sendMessage(currentToken.tabId,{type:'progress',key:job.key,text:'暂未读到字幕，正在尝试开启 AI 字幕后恢复原状态…'}).catch(()=>{});
      const activationToken=await ensureJob(job);
      const recovered=await execute(activationToken.tabId,activateAiSubtitles,[job.key,v]);
      await ensureJob(job);
      tracks=Array.isArray(recovered.tracks)?recovered.tracks.filter(t=>t.subtitle_url):[];
    }
    if(!tracks.length)throw Error('已尝试自动获取字幕，但 B站暂未提供可读取的字幕，本次无法用 AI 识别。');
    tracks.sort((a,b)=>rank(a.lan)-rank(b.lan));
    const track=tracks[0],subUrl=new URL(track.subtitle_url,'https://www.bilibili.com');
    if(subUrl.protocol!=='https:'||subUrl.username||subUrl.password||!(subUrl.hostname.endsWith('.hdslb.com')||subUrl.hostname==='subtitle.bilibili.com'))throw Error('不支持的字幕来源');
    await ensureJob(job);
    const rows=normalizeBody((await jsonFetch(subUrl.href)).body),url=provider.url;
    const result=await analyzeJev({rows,model:provider.model,title:v.title,brands:s.brandHints,threshold:provider.threshold,duration:v.duration,
      ask:async body=>{await ensureJob(job);return usage.request(provider,()=>jsonFetch(url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${provider.key}`},body:JSON.stringify(body)}));},
      onProgress:async text=>{await chromeApi.tabs.sendMessage((await ensureJob(job)).tabId,{type:'progress',key:job.key,text}).catch(()=>{});}
    });
    return {...result,provider:'jev',segments:result.segments.map(segment=>({...segment,id:crypto.randomUUID(),source:'ai',provider:'jev'})),
      title:v.title,language:track.lan_doc||track.lan,analysisConfig:JSON.parse(configIdentity(s,provider)),bvid:v.bvid,cid:v.cid,duration:v.duration};
  }

  async function analyze(token,s,force){
    await ensure(token);
    const v=await execute(token.tabId,readMetadata,[token.key]);
    if(!/^BV[\w]+$/.test(v.bvid)||!/^\d+$/.test(String(v.cid))||!Number.isFinite(v.duration)||v.duration<=0||!token.key.startsWith(v.bvid+':'))throw Error('视频信息不完整');
    await ensure(token);
    const lookup=s.communityEnabled?await community.lookup(v,{force}):{status:'disabled',hasAd:false,segments:[]};
    await ensure(token);
    const communityState={status:lookup.status,hasAd:lookup.hasAd===true,...(lookup.message?{message:lookup.message}:{})};
    if(lookup.status==='found'||lookup.hasAd){
      const result={...v,provider:'community',analysisStatus:'community',community:communityState,segments:lookup.segments||[],hasFullVideoAd:!!lookup.hasFullVideoAd};
      token.result=result;await persistToken(token);await ensure(token);return structuredClone(result);
    }
    if(!s.jevApiKey){
      const result={...v,provider:s.provider,analysisStatus:'incomplete',community:communityState,segments:[],
        message:lookup.status==='disabled'?'社区标注已关闭，可开启社区标注或配置 AI 进行识别。':lookup.status==='empty'?'社区暂无广告标注，可在设置中配置 AI 补充识别。':'社区查询暂不可用，可在设置中配置 AI 进行本地识别。',
        coverage:{mode:'none',complete:false}};
      token.result=result;await persistToken(token);await ensure(token);return structuredClone(result);
    }
    const provider=providerConfig(s);
    if(!await chromeApi.permissions.contains({origins:[new URL(provider.url).protocol+'//'+new URL(provider.url).hostname+'/*']}))throw Error('请在设置页保存并允许访问 AI 接口');
    await ensure(token);
    const id=await fingerprint(`${v.bvid}:${v.cid}:${v.duration}:${configIdentity(s,provider)}`);
    const cached=await cacheGet(id);await ensure(token);
    let result;
    if(!force&&cached)result={...structuredClone(cached),cached:true};
    else {
      const jobId=`${id}:${token.revision}`;let job=jobs.get(jobId);
      if(!job){
        job={key:token.key,revision:token.revision,subscribers:new Map([[token.tabId,token]])};
        jobs.set(jobId,job);
        job.promise=runAi(job,s,provider,v).then(async value=>{await ensureJob(job);await cachePut(id,value);return value;}).finally(()=>jobs.delete(jobId));
      }else job.subscribers.set(token.tabId,token);
      result=structuredClone(await job.promise);
    }
    await ensure(token);
    // A fresh community result always controls the cached AI result too.
    result.community=communityState;token.result=result;
    await persistToken(token);await ensure(token);return structuredClone(result);
  }
  async function submit(token,id,automatic){
    const blocked=message=>({status:'blocked',message});
    if(!token||!await current(token))return blocked('视频或配置已切换，请重新识别');
    const segment=token.result?.segments?.find(s=>s.id===id);
    if(!segment||segment.source!=='ai')return blocked('未找到当前视频的 AI 候选');
    async function allowed(){
      if(!await current(token))return false;const s=await settings();
      return tabs.get(token.tabId)===token&&token.revision===revision&&s.enabled&&s.communityEnabled&&(!automatic||(!segment.autoSubmitSuppressed&&s.autoSkip&&s.communityAutoSubmit&&token.result.community.status==='empty'&&segment.provider==='jev'&&segment.autoSubmitEligible===true&&segment.confidence>=.90&&segment.boundaryConfidence>=.90&&segment.end-segment.start>=s.minDuration));
    }
    if(!await allowed())return blocked(automatic?'当前片段不满足自动投稿条件':'请先开启插件和社区标注');
    if(segment.submissionStatus==='submitted'||segment.submissionStatus==='duplicate')return {status:'duplicate',message:'此片段已经提交'};
    if(segment.submissionInFlight||automatic&&segment.autoSubmitAttempted)return blocked('此片段已尝试提交，请查看结果后手动处理');
    segment.submissionInFlight=true;if(automatic)segment.autoSubmitAttempted=true;
    try{
      await persistToken(token);
      const result=await community.submit({bvid:token.result.bvid,cid:token.result.cid,duration:token.result.duration},
        {id:segment.id,start:segment.start,end:segment.end,confidence:segment.confidence,boundaryConfidence:segment.boundaryConfidence,autoSubmitEligible:segment.autoSubmitEligible,truncated:segment.truncated},{automatic,provider:segment.provider,isCurrent:allowed});
      if(await current(token))segment.submissionStatus=result.status;
      return result;
    }finally{delete segment.submissionInFlight;await persistToken(token);}
  }
  async function handle(msg,sender){
    if(typeof sender.url==='string'&&sender.url===chromeApi.runtime.getURL?.('options.html')){
      const s=await settings(),p=providerConfig(s);
      if(msg.type==='usage')return usage.summary(p);
      if(msg.type==='testConnection'){
        if(!p.key)throw Error('请先保存 JEV Key');
        const reply=await usage.request(p,()=>jsonFetch(p.url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${p.key}`},body:JSON.stringify(connectionProbe(s))}));
        validateProbe('jev',reply);return {};
      }
    }

    const tabId=sender.tab?.id;if(!Number.isInteger(tabId)||!videoKey(sender.url))throw Error('不支持的页面');
    if(msg.type==='settings'){const s=await settings();return {provider:s.provider,enabled:s.enabled,autoSkip:s.autoSkip,autoAnalyze:s.autoAnalyze,threshold:s.jevThreshold,minDuration:s.minDuration,communityEnabled:s.communityEnabled,communityAutoSubmit:s.communityAutoSubmit};}
    if(msg.type==='options'){await chromeApi.runtime.openOptionsPage();return {};}
    if(msg.type==='analyze'){
      const capturedRevision=revision,s=await settings(),configHash=await settingsHash(s);
      if(capturedRevision!==revision)throw Error('配置已更新，请重新识别');
      if(!s.enabled)throw Error('广告跳过已关闭');
      let token=await restoreToken(tabId,msg.key);
      if(capturedRevision!==revision)throw Error('配置已更新，请重新识别');
      if(!token||token.key!==msg.key||token.revision!==revision||msg.force){
        const previous=token?.key===msg.key&&token.revision===revision?token.result:undefined;
        token={tabId,key:msg.key,revision:capturedRevision,configHash,...(previous?{result:previous}:{})};tabs.set(tabId,token);
      }
      if(!token.pending)token.pending=analyze(token,s,!!msg.force).finally(()=>{delete token.pending;});
      return token.pending;
    }
    if(msg.type==='retain'){
      const token=await restoreToken(tabId,msg.key);
      if(!token||token.key!==msg.key||!await current(token))return {status:'blocked',message:'视频或配置已切换'};
      const segment=token.result?.segments?.find(segment=>segment.id===msg.segmentId&&segment.source==='ai');
      if(!segment)return {status:'blocked',message:'未找到当前视频的 AI 候选'};
      segment.autoSubmitSuppressed=true;await persistToken(token);
      return {status:'retained',message:'已停止后续自动投稿；已发出的请求无法撤回。'};
    }
    if(msg.type==='submit'||msg.type==='skipped'){
      const token=await restoreToken(tabId,msg.key);if(!token||token.key!==msg.key)return {status:'blocked',message:'请先识别当前视频'};
      return submit(token,msg.segmentId,msg.type==='skipped');
    }
    throw Error('未知请求');
  }
  chromeApi.storage.onChanged.addListener((changes,area)=>{
    if(area!=='local'||!changes.settings)return;revision++;tabs.clear();
    void serializeRegistry(()=>session.remove(REGISTRY_KEY)).catch(()=>{});
    chromeApi.tabs.query({url:'https://www.bilibili.com/*'}).then(list=>Promise.allSettled(list.map(tab=>chromeApi.tabs.sendMessage(tab.id,{type:'settingsChanged'})))).catch(()=>{});
  });
  chromeApi.tabs.onUpdated?.addListener((tabId,change)=>{
    if(!change.url)return;const key=videoKey(change.url);
    if(key!==tabs.get(tabId)?.key)tabs.delete(tabId);
    void forgetSnapshot(tabId,key).catch(()=>{});
  });
  chromeApi.tabs.onRemoved?.addListener(tabId=>{tabs.delete(tabId);void forgetSnapshot(tabId).catch(()=>{});});
  return {handle};
}

if(globalThis.chrome?.runtime?.onMessage){
  chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
  chrome.action.onClicked.addListener(()=>chrome.runtime.openOptionsPage());
  const background=createBackground();
  chrome.runtime.onMessage.addListener((msg,sender,respond)=>{
    if(sender.url!==chrome.runtime.getURL('options.html')&&(!sender.tab||!videoKey(sender.url)))return;
    background.handle(msg,sender).then(result=>respond({ok:true,result}),async error=>{
      const s={...DEFAULTS,...(await chrome.storage.local.get('settings')).settings};
      let message=error.message||'操作失败';for(const key of [s.apiKey,s.jevApiKey])if(key)message=message.split(key).join('[已隐藏]');
      respond({ok:false,error:message.replace(/(?:sk-|apikey_)[\w-]+/g,'[已隐藏]')});
    });return true;
  });
}
