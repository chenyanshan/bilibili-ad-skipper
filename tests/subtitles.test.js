import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';
import {readSubtitles,activateAiSubtitles} from '../extension/subtitles.js';
const bvid='BV1Jda36jENB',video={bvid,cid:1234},expected=bvid+':1';
function fixture({wasOff=true,control=true,loginRequired=false,tracks=[],onPause,onFetch}={}){
 let clock=0,calls=0,enabled=!wasOff;const clicks=[],listeners=new Map(),media={};
 const off={classList:{contains:()=>!enabled},click(){clicks.push('off');enabled=false}};
 const ai={classList:{contains:()=>enabled},click(){clicks.push('ai-zh');enabled=true}};
 const root={isConnected:true,querySelector:s=>s.includes('language-unlogin')?(loginRequired?{}:null):s.includes('close-switch')?off:s.includes('[data-lan="ai-zh"]')?ai:null,addEventListener:(t,f)=>listeners.set(t,f),removeEventListener:t=>listeners.delete(t)};
 const docListeners=new Map();
 const document={querySelector:s=>s==='video'?media:control?root:null,addEventListener:(t,f)=>docListeners.set(t,f),removeEventListener:t=>docListeners.delete(t)};
 const location={pathname:'/video/'+bvid+'/',href:'https://www.bilibili.com/video/'+bvid+'/'};
 const state={clicks,listeners,docListeners,root,document,location,get enabled(){return enabled},get calls(){return calls},get clock(){return clock}};
 const globals={document,location,URL,AbortSignal,getComputedStyle:()=>({display:"block"}),Date:{now:()=>clock},setTimeout:(f,ms)=>{clock+=ms;onPause?.(state);f();},fetch:async(...args)=>{calls++;return onFetch?onFetch(state,...args):{json:async()=>({code:0,data:{subtitle:{subtitles:tracks}}})}},expected,video};
 state.run=(fn=activateAiSubtitles)=>vm.runInNewContext(`(${fn.toString()})(expected,video)`,globals);
 return state;
}
const track={lan:'ai-zh',subtitle_url:'https://test.hdslb.com/sub.json'};
test('缺字幕时开启中文AI字幕，取到字幕后恢复关闭',async()=>{
 const f=fixture({tracks:[track]}),r=await f.run();assert.equal(r.tracks.length,1);assert.equal(r.attempted,true);assert.deepEqual(f.clicks,['ai-zh','off']);assert.equal(f.enabled,false);assert.equal(f.listeners.size,0);assert.equal(f.docListeners.size,0);
});
test('用户原本开启字幕，不切换语言也不关闭',async()=>{
 const f=fixture({wasOff:false,tracks:[track]});assert.equal((await f.run()).tracks.length,1);assert.deepEqual(f.clicks,[]);assert.equal(f.enabled,true);
});
test('没有已知AI字幕控件时不点其他按钮，也不循环请求',async()=>{
 const f=fixture({control:false});assert.equal((await f.run()).attempted,false);assert.equal(f.calls,0);assert.equal(f.clock,2000);assert.deepEqual(f.clicks,[]);
});
test('异步加载的控件出现后才尝试，超时后仍恢复关闭',async()=>{
 const f=fixture({control:false,onPause:s=>{if(s.clock>=500)s.document.querySelector=selector=>selector==='video'?null:s.root;}});
 // Keep the same media identity while simulating only the control mount.
 const query=f.document.querySelector;f.document.querySelector=s=>s==='video'?null:query(s);
 const result=await f.run();assert.equal(result.tracks.length,0);assert.equal(result.attempted,true);assert.equal(f.calls,4);assert.deepEqual(f.clicks,['ai-zh','off']);assert.ok(f.clock<=8000);
});
test('字幕接口失败也恢复自己打开的字幕，不返回无广告',async()=>{
 const f=fixture({onFetch:async()=>{throw Error('network');}}),r=await f.run();assert.equal(r.tracks.length,0);assert.equal(f.calls,4);assert.deepEqual(f.clicks,['ai-zh','off']);
});
test('用户在等待中点击字幕控件，尊重其选择不自动关闭',async()=>{
 const f=fixture({tracks:[track],onPause:s=>s.listeners.get('click')?.({isTrusted:true})});await f.run();assert.deepEqual(f.clicks,['ai-zh']);assert.equal(f.enabled,true);assert.equal(f.calls,0);
});
test('配置取消时恢复原状态并停止后续字幕请求',async()=>{
 const f=fixture({onPause:s=>s.docListeners.get('bili-ad-skipper:cancel-subtitles')?.()});await f.run();assert.deepEqual(f.clicks,['ai-zh','off']);assert.equal(f.calls,0);
});
test('切换BV或分P后不点击新视频的字幕开关',async()=>{
 for(const change of ['bvid','part']){
  const f=fixture({onPause:s=>{if(change==='bvid')s.location.pathname='/video/BV1PdeFzyEyf/';else s.location.href+='?p=2';}});
  await f.run();assert.deepEqual(f.clicks,['ai-zh']);assert.equal(f.calls,0);
 }
});
test('播放器控件被替换后不触碰新控件',async()=>{
 const f=fixture({onPause:s=>{s.root.isConnected=false;}});await f.run();assert.deepEqual(f.clicks,['ai-zh']);assert.equal(f.calls,0);
});
test('获取普通字幕不操作控件，API返回后再次验证视频身份',async()=>{
 const f=fixture({tracks:[track]});assert.equal((await f.run(readSubtitles)).length,1);assert.deepEqual(f.clicks,[]);
 const changed=fixture({onFetch:async s=>{s.location.href+='?p=2';return {json:async()=>({code:0,data:{subtitle:{subtitles:[track]}}})}}});await assert.rejects(changed.run(readSubtitles),/视频已切换/);
});

test('播放器要求登录时不点击字幕，不弹登录窗口',async()=>{
 const f=fixture({loginRequired:true});assert.equal((await f.run()).attempted,false);assert.deepEqual(f.clicks,[]);assert.equal(f.calls,0);
});
