// Both functions are serialized by chrome.scripting into the page's MAIN world.
// Keep them self-contained; never pass settings or API keys into this context.
export async function readSubtitles(expected,video){
  function current(){
    const bvid=location.pathname.match(/\/video\/(BV[\w]+)/)?.[1];
    return bvid===video.bvid&&`${bvid}:${Number(new URL(location.href).searchParams.get('p')||1)}`===expected;
  }
  if(!current())throw Error('视频已切换，请重试');
  async function get(path){const r=await fetch('https://api.bilibili.com'+path,{credentials:'include',signal:AbortSignal.timeout(15000)});const j=await r.json();if(j.code!==0)throw Error('无法读取播放器字幕');return j.data;}
  let p;try{p=await get(`/x/player/wbi/v2?bvid=${video.bvid}&cid=${video.cid}`);}catch{if(!current())throw Error('视频已切换，请重试');p=await get(`/x/player/v2?bvid=${video.bvid}&cid=${video.cid}`);}
  if(!current())throw Error('视频已切换，请重试');
  return p.subtitle?.subtitles||[];
}

export async function activateAiSubtitles(expected,video){
  const started=Date.now(),deadline=started+8000;
  const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  let cancelled=false,userChanged=false,root,off,ai,opened=false;
  const media=document.querySelector('video');
  function current(){
    const bvid=location.pathname.match(/\/video\/(BV[\w]+)/)?.[1];
    return !cancelled&&bvid===video.bvid&&`${bvid}:${Number(new URL(location.href).searchParams.get('p')||1)}`===expected&&
      (!media||document.querySelector('video')===media);
  }
  function cancel(){cancelled=true;}
  function interaction(event){if(event.isTrusted)userChanged=true;}
  const active=el=>el?.classList.contains('bpx-state-active');
  function sameControl(){return root?.isConnected&&document.querySelector('.bpx-player-ctrl-subtitle')===root;}
  // Ignore our own programmatic click, but leave the user's later choice alone.
  document.addEventListener('bili-ad-skipper:cancel-subtitles',cancel);
  try{
    if(!current())return {tracks:[],attempted:false};
    // Player controls can mount slightly after the metadata response.
    do{
      root=document.querySelector('.bpx-player-ctrl-subtitle');
      off=root?.querySelector('.bpx-player-ctrl-subtitle-close-switch');
      ai=root?.querySelector('.bpx-player-ctrl-subtitle-language-item[data-lan="ai-zh"]');
      if(root&&off&&ai)break;
      await pause(250);
    }while(current()&&Date.now()-started<2000);
    if(!current()||!root||!off||!ai)return {tracks:[],attempted:false};
    const login=root.querySelector('.bpx-player-ctrl-subtitle-language-unlogin');
    if(login&&getComputedStyle(login).display!=='none')return {tracks:[],attempted:false};
    root.addEventListener('click',interaction,true);
    root.addEventListener('keydown',interaction,true);
    const wasOff=active(off);
    if(wasOff){
      // Click only the known Chinese AI track, never login, upload or translation controls.
      opened=true;ai.click();
    }
    for(let attempt=0;attempt<4&&current()&&sameControl()&&!userChanged;attempt++){
      await pause(attempt?1000:350);
      if(!current()||!sameControl()||userChanged||Date.now()>=deadline)break;
      try{
        const response=await fetch(`https://api.bilibili.com/x/player/wbi/v2?bvid=${video.bvid}&cid=${video.cid}`,{
          credentials:'include',cache:'no-store',signal:AbortSignal.timeout(Math.max(1,Math.min(1800,deadline-Date.now()))),
        });
        const json=await response.json();
        if(!current()||!sameControl()||userChanged)break;
        const tracks=Array.isArray(json.data?.subtitle?.subtitles)?json.data.subtitle.subtitles.filter(t=>t.subtitle_url):[];
        if(json.code===0&&tracks.length)return {tracks,attempted:opened};
      }catch{ /* A failed retry is unavailable subtitles, never a no-ad result. */ }
    }
    return {tracks:[],attempted:opened};
  }finally{
    // Cancellation should restore our own temporary switch too. Navigation must
    // never turn subtitles off in the replacement player or a different video.
    const bvid=location.pathname.match(/\/video\/(BV[\w]+)/)?.[1];
    const sameVideo=bvid===video.bvid&&`${bvid}:${Number(new URL(location.href).searchParams.get('p')||1)}`===expected&&
      (!media||document.querySelector('video')===media);
    if(opened&&!userChanged&&sameVideo&&sameControl()&&active(ai)&&!active(off))off.click();
    root?.removeEventListener('click',interaction,true);
    root?.removeEventListener('keydown',interaction,true);
    document.removeEventListener('bili-ad-skipper:cancel-subtitles',cancel);
  }
}
