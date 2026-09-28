import {providerConfig,detectWithJev} from './providers.js';
import {DEFAULTS,normalizeBody,parseResult,mergeSegments,SYSTEM,planAnalysis,compactRows,touchesBoundary,budgetChunks,sponsorContext} from './core.js';
chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
chrome.action.onClicked.addListener(()=>chrome.runtime.openOptionsPage());
const running=new Map();let settingsRevision=0;
chrome.storage.onChanged.addListener((changes,area)=>{
  if(area!=='local'||!changes.settings)return;settingsRevision++;
  chrome.tabs.query({url:'https://www.bilibili.com/*'}).then(tabs=>Promise.allSettled(tabs.map(tab=>chrome.tabs.sendMessage(tab.id,{type:'settingsChanged'})))).catch(()=>{});
});
async function settings(){return {...DEFAULTS,...(await chrome.storage.local.get('settings')).settings};}
async function jsonFetch(url, options={}) {
  const r=await fetch(url,{...options,redirect:'error',signal:AbortSignal.timeout(25000)});
  if(!r.ok)throw Error(`请求失败 HTTP ${r.status}`);
  return r.json();
}
// 在 B 站页面主世界请求播放器接口，复用浏览器 Cookie；Cookie 不传给 AI。
async function getVideo(tabId, expected) {
  const [r]=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:async (expected)=>{
    const bvid=location.pathname.match(/\/video\/(BV[\w]+)/)?.[1];
    const page=Number(new URL(location.href).searchParams.get('p')||1);
    if(!bvid||`${bvid}:${page}`!==expected)throw Error('视频已切换，请重试');
    async function get(path){const r=await fetch('https://api.bilibili.com'+path,{credentials:'include',signal:AbortSignal.timeout(15000)});const j=await r.json();if(j.code!==0)throw Error(`B站接口 ${j.code}: ${j.message}`);return j.data;}
    const v=await get('/x/web-interface/view?bvid='+bvid);
    const part=v.pages.find(p=>p.page===page);if(!part)throw Error('未找到当前分 P');
    let p;try{p=await get(`/x/player/wbi/v2?bvid=${bvid}&cid=${part.cid}`);}catch{p=await get(`/x/player/v2?bvid=${bvid}&cid=${part.cid}`);}
    return {bvid,cid:part.cid,title:v.title+' '+part.part,duration:part.duration,subtitles:p.subtitle?.subtitles||[]};
  },args:[expected]});
  if(!r?.result)throw Error('读取播放器失败，请刷新 B 站页面');return r.result;
}
async function analyze(tabId, key, force=false) {
  const revision=settingsRevision;
  const s=await settings(),provider=providerConfig(s);if(!provider.key)throw Error(`请先点击插件图标配置 ${provider.name} API Key`);
  const url=provider.url;
  if(!await chrome.permissions.contains({origins:[new URL(url).origin+'/*']}))throw Error('请在设置页保存并允许访问 AI 接口');
  const v=await getVideo(tabId,key);
  const cacheKey=`cache:v6:${provider.id}:${provider.threshold}:${s.brandHints}:${s.economy?"candidates":"full"}:${v.bvid}:${v.cid}:${provider.model}:${url}`;
  const cached=(await chrome.storage.local.get(cacheKey))[cacheKey];
  if(!force&&cached&&Date.now()-cached.time<7*86400000)return {...cached.result,cached:true};
  const tracks=v.subtitles.filter(t=>t.subtitle_url).sort((a,b)=>rank(a.lan)-rank(b.lan));
  if(!tracks.length)throw Error('B站尚未提供字幕。请在播放器里开启一次 AI 字幕后重试；若仍没有，本视频暂无法识别。');
  const track=tracks[0],subUrl=new URL(track.subtitle_url,'https://www.bilibili.com');
  if(subUrl.protocol!=='https:'||!(subUrl.hostname.endsWith('.hdslb.com')||subUrl.hostname==='subtitle.bilibili.com'))throw Error('不支持的字幕来源');
  const rows=normalizeBody((await jsonFetch(subUrl.href)).body);
  const {parts,stats}=planAnalysis(rows,s.economy,v.duration,s.brandHints);if(parts.length>24)throw Error('候选字幕过多，超过单视频 24 次请求预算，本次未调用 AI');
  const context=sponsorContext(rows);
  const found=[];let incomplete=0;stats.actualRequests=0;stats.promptTokens=0;stats.completionTokens=0;stats.usageReported=true;
  async function classify(part) {
    if(revision!==settingsRevision)throw Error('配置已更新，停止旧服务请求');
    const current=await chrome.tabs.get(tabId);
    const currentUrl=new URL(current.url||'https://www.bilibili.com');
    if(`${currentUrl.pathname.match(/\/video\/(BV[\w]+)/)?.[1]}:${Number(currentUrl.searchParams.get('p')||1)}`!==key)throw Error('视频已切换，停止后续 AI 请求');
    async function ask(body){
      if(revision!==settingsRevision)throw Error('配置已更新，停止旧服务请求');
      if(stats.actualRequests>=24)throw Error('达到单视频 24 次请求上限，本次不自动跳过');
      const tab=await chrome.tabs.get(tabId);const u=new URL(tab.url||'https://www.bilibili.com');
      if(`${u.pathname.match(/\/video\/(BV[\w]+)/)?.[1]}:${Number(u.searchParams.get('p')||1)}`!==key)throw Error('视频已切换，停止后续请求');
      stats.actualRequests++;
      const reply=await jsonFetch(url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${provider.key}`},body:JSON.stringify(body)});
      if(reply.usage){stats.promptTokens+=reply.usage.input_tokens||reply.usage.prompt_tokens||0;stats.completionTokens+=reply.usage.output_tokens||reply.usage.completion_tokens||0;}else stats.usageReported=false;
      return reply;
    }
    if(provider.id==='jev')return detectWithJev({rows:part,model:provider.model,title:v.title,context,brands:s.brandHints,threshold:provider.threshold,duration:v.duration,ask});
    const reply=await ask({model:provider.model,messages:[{role:'system',content:SYSTEM},{role:'user',content:JSON.stringify({title:v.title,sponsor_context:context,ad_brand_hints:s.brandHints,subtitles:compactRows(part)})}],temperature:0,max_tokens:1600});
    const choice=reply.choices?.[0];
    if(choice?.finish_reason==='length')throw Error('AI 输出被截断，请更换模型或重试');
    const text=choice?.message?.content;if(typeof text!=='string')throw Error('AI 未返回文本，请检查模型配置');
    return parseResult(text,part,v.duration);
  }
  for(let i=0;i<parts.length;i++) {
    await chrome.tabs.sendMessage(tabId,{type:'progress',key,text:`后台确认广告 ${i+1}/${parts.length}…（筛选 ${stats.selectedRows}/${stats.totalRows} 条字幕）`}).catch(()=>{});
    const part=parts[i];const detected=await classify(part);
    const edges=detected.filter(seg=>touchesBoundary(seg,part,rows));
    found.push(...detected.filter(seg=>!touchesBoundary(seg,part,rows)));
    if(edges.length) {
      // 疑似广告碰到窗口边界时，只扩一次。仍截断就保留播放，避免跳过正片。
      const expanded=rows.filter(r=>r.to>part[0].from-60&&r.from<part.at(-1).to+60);
      if(budgetChunks(expanded).length===1&&stats.actualRequests+(parts.length-i-1)<24){
        stats.sentChars+=JSON.stringify(compactRows(expanded)).length;
        const retried=await classify(expanded);
        incomplete+=retried.filter(seg=>touchesBoundary(seg,expanded,rows)).length;
        found.push(...retried.filter(seg=>!touchesBoundary(seg,expanded,rows)));
      }else incomplete+=edges.length;
    }
    if(stats.actualRequests>=24&&i+1<parts.length)throw Error('已达到 24 次请求预算，未完成识别，本次不自动跳过');
  }
  const result={provider:provider.id,stats,incomplete,segments:mergeSegments(found).filter(x=>x.end-x.start<=240&&x.end-x.start<v.duration*0.95),title:v.title,language:track.lan_doc||track.lan};
  await chrome.storage.local.set({[cacheKey]:{time:Date.now(),result}});
  const all=await chrome.storage.local.get(null);const keys=Object.keys(all).filter(k=>k.startsWith('cache:')).sort((a,b)=>all[b].time-all[a].time);if(keys.length>100)await chrome.storage.local.remove(keys.slice(100));
  return result;
}
function rank(lan){return ['zh-CN','zh-Hans','zh','ai-zh'].indexOf(lan)<0?10:['zh-CN','zh-Hans','zh','ai-zh'].indexOf(lan);}
chrome.runtime.onMessage.addListener((msg,sender,respond)=>{
  const tabId=sender.tab?.id;
  if(!tabId||!sender.url?.startsWith('https://www.bilibili.com/'))return;
  (async()=>{
    if(msg.type==='settings'){const s=await settings();return {provider:s.provider,enabled:s.enabled,autoSkip:s.autoSkip,autoAnalyze:s.autoAnalyze,threshold:providerConfig(s).threshold,minDuration:s.minDuration};}
    if(msg.type==='options'){await chrome.runtime.openOptionsPage();return {};}
    if(msg.type==='analyze'){
      const id=`${tabId}:${msg.key}:${settingsRevision}`;
      if(!running.has(id))running.set(id,analyze(tabId,msg.key,!!msg.force).finally(()=>running.delete(id)));
      return await running.get(id);
    }throw Error('未知请求');
  })().then(result=>respond({ok:true,result}),e=>respond({ok:false,error:e.message?.replace(/(?:sk-|apikey_)[\w-]+/g,'[已隐藏]')||'操作失败'}));return true;
});
