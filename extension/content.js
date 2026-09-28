(()=>{
  let key='',epoch=0,segments=[],ignored=new Set(),reported=new Set(),submissions=new Map(),cfg={},busy=false,video=null,host,root,status,list,button,undo,lastSkip=null;
  const send=async msg=>{const r=await chrome.runtime.sendMessage(msg);if(!r?.ok)throw Error(r?.error||'插件连接失败，请刷新页面');return r.result;};
  const time=n=>`${Math.floor(n/60)}:${String(Math.floor(n%60)).padStart(2,'0')}`;
  const id=s=>`${s.source||'ai'}:${s.provider||''}:${s.start}:${s.end}`;
  function locationKey(){const bvid=location.pathname.match(/\/video\/(BV[\w]+)/)?.[1];return bvid?`${bvid}:${Number(new URL(location.href).searchParams.get('p')||1)}`:'';}
  const currentVideo=()=>Boolean(key)&&locationKey()===key;
  function retain(s){if(!currentVideo()||!s)return;ignored.add(id(s));if(!community(s)&&s.id)send({type:'retain',key,segmentId:s.id}).catch(()=>{});}
  const community=s=>s.source==='community';
  function mount(){
    host=document.createElement('div');host.id='bili-ad-skipper';root=host.attachShadow({mode:'closed'});
    root.innerHTML=`<style>:host{position:fixed;right:18px;bottom:76px;z-index:2147483000;font:13px/1.5 system-ui;color:#e8edf4}details{width:min(290px,calc(100vw - 24px));max-height:calc(100vh - 100px);overflow:auto;background:#17202ef5;border:1px solid #475569;border-radius:12px;box-shadow:0 8px 28px #0004;padding:12px}summary{cursor:pointer;font-weight:650;min-height:24px}p{margin:10px 0;overflow-wrap:anywhere}button{background:#334155;color:#fff;border:1px solid #64748b;border-radius:6px;padding:7px 9px;min-height:36px;cursor:pointer;margin:3px 4px 3px 0}button:hover{background:#475569}button:disabled{opacity:.6;cursor:not-allowed}:focus-visible{outline:2px solid #7dd3fc;outline-offset:2px}.row{border-top:1px solid #475569;padding:8px 0;overflow-wrap:anywhere}#list{max-height:240px;overflow:auto}.muted{color:#b6c5d8;font-size:12px}.feedback{min-height:18px;color:#b6c5d8;font-size:12px}[hidden]{display:none!important}@media(max-width:500px){:host{right:12px;bottom:24px}button{min-height:44px}details{max-height:calc(100vh - 48px)}}</style><details><summary>广告跳过</summary><p id="status" role="status" aria-live="polite">就绪</p><button id="analyze">重新识别</button><button id="settings">设置</button><button id="undo" hidden>撤销跳过</button><div id="list"></div><p class="muted">社区广告优先；无广告标注时才向所选 AI 发送字幕。可在设置中关闭。</p></details>`;
    document.documentElement.append(host);status=root.querySelector('#status');list=root.querySelector('#list');button=root.querySelector('#analyze');undo=root.querySelector('#undo');
    button.onclick=()=>analyze(true);root.querySelector('#settings').onclick=()=>send({type:'options'}).catch(e=>status.textContent=e.message);
    undo.onclick=()=>{if(lastSkip&&video&&currentVideo()){retain(segments.find(s=>id(s)===lastSkip.id));video.currentTime=lastSkip.from;status.textContent='已恢复播放，本次不再自动跳过或自动投稿该片段';lastSkip=null;undo.hidden=true;render();}};
  }
  async function submit(s,automatic=false){
    const segmentId=id(s),token=epoch,current=key;
    if(!currentVideo()||community(s)||submissions.get(segmentId)?.status==='pending')return;
    submissions.set(segmentId,{status:'pending',message:automatic?'正在自动投稿…':'正在投稿…'});render();
    try{
      const result=await send({type:automatic?'skipped':'submit',key:current,segmentId:s.id});
      if(token!==epoch||current!==key)return;
      submissions.set(segmentId,{status:result.status,message:result.message||({submitted:'已投稿',duplicate:'已有投稿，无需重复',blocked:'暂不符合投稿条件',error:'投稿失败，可手动重试'}[result.status]||'投稿未完成')});
    }catch(e){if(token===epoch&&current===key)submissions.set(segmentId,{status:'error',message:`投稿失败：${e.message}`});}
    finally{if(token===epoch&&current===key)render();}
  }
  function render(){
    list.replaceChildren();segments.forEach((s,i)=>{
      const segmentId=id(s),row=document.createElement('div');row.className='row';
      const text=document.createElement('div'),source=community(s)?'社区广告':`${(s.provider||cfg.provider||'AI').toUpperCase()} 识别`;
      text.textContent=`${time(s.start)}–${time(s.end)} · ${source}${!community(s)&&Number.isFinite(s.confidence)?` · ${Math.round(s.confidence*100)}%`:''}`;
      const reason=document.createElement('div');reason.className='muted';reason.textContent=s.reason||'';
      const jump=document.createElement('button');jump.textContent='跳过';jump.onclick=()=>{if(video)skip(i,false);};
      const keep=document.createElement('button');keep.textContent=ignored.has(segmentId)?'已保留':'保留片段';keep.disabled=ignored.has(segmentId);keep.onclick=()=>{retain(s);render();};row.append(text,reason,jump,keep);
      if(!community(s)&&s.id){
        const state=submissions.get(segmentId),upload=document.createElement('button');
        upload.textContent=state?.status==='pending'?'投稿中…':state?.status==='submitted'?'已投稿':state?.status==='duplicate'?'已收录':state?.status==='error'?'重试投稿':'手动投稿';
        upload.disabled=['pending','submitted','duplicate'].includes(state?.status);upload.onclick=()=>submit(s);row.append(upload);
        if(state){const feedback=document.createElement('div');feedback.className='feedback';feedback.setAttribute('role','status');feedback.textContent=state.message;row.append(feedback);}
      }
      list.append(row);
    });
  }
  function skip(index,automatic=false){
    if(!currentVideo()||!video||!segments[index])return;
    const s=segments[index],from=video.currentTime,target=Math.min(s.end,Number.isFinite(video.duration)?video.duration:s.end);
    video.currentTime=target;
    if(video.currentTime<=from+.1)return;
    lastSkip={id:id(s),from};undo.hidden=false;root.querySelector('details').open=true;status.textContent=`已跳过 ${time(s.start)}–${time(s.end)} · ${community(s)?'社区广告':'AI 识别'}，可撤销`;
    if(automatic&&!community(s)&&s.id&&!reported.has(id(s))&&!ignored.has(id(s))){
      reported.add(id(s));
      // Only this real automatic seek path can report a skip; the background revalidates eligibility.
      if(cfg.communityAutoSubmit&&s.provider==='jev'&&s.autoSubmitEligible)submit(s,true);
    }
  }
  function tick(){
    if(!currentVideo()||!cfg.enabled||!cfg.autoSkip||!video||video.paused||video.seeking)return;
    const i=segments.findIndex(s=>!ignored.has(id(s))&&(community(s)||(s.confidence>=cfg.threshold&&s.end-s.start>=(cfg.minDuration??20)))&&video.currentTime>=s.start&&video.currentTime<s.end-.2);
    if(i>=0)skip(i,true);
  }
  async function analyze(force=false){
    if(!currentVideo()||busy||!cfg.enabled)return;const token=epoch,current=key;busy=true;button.disabled=true;status.textContent=cfg.communityEnabled?'查询社区广告…':'读取字幕…';
    try{
      const result=await send({type:'analyze',key:current,force});if(token!==epoch||current!==key)return;
      if(result.analysisStatus==='incomplete'&&!result.segments?.length&&segments.length){status.textContent='本次识别未完成，保留已有广告结果，可重试';return;}
      segments=result.segments||[];render();
      const source=result.provider==='community'?'社区':result.provider==='jev'?'JEV':'LLM';
      if(segments.length)status.textContent=`${source} · 找到 ${segments.length} 段广告${result.cached?'（本机缓存）':''}；${cfg.autoSkip?(result.provider==='community'?'自动跳过':`符合评分且 ≥${cfg.minDuration??20} 秒时自动跳过`):'手动跳过'}`;
      else if(result.provider==='community')status.textContent=result.message||'社区已有广告标注，无可直接跳过的区间；不调用 AI';
      else if(result.analysisStatus==='no_ads')status.textContent='本次未发现广告，结果仅在本机保留 7 天';
      else status.textContent=result.message||'本次识别未完成；可检查配置或重新识别';
      if(result.incomplete&&segments.length)status.textContent+='；另有边界不完整的片段，保留播放';
      if(['error','unavailable'].includes(result.community?.status))status.textContent+='；社区暂不可用';
    }catch(e){if(token===epoch&&current===key)status.textContent=`${e.message}${segments.length?'；已保留已有广告结果':''}`;}
    finally{if(token===epoch&&current===key){busy=false;button.disabled=false;}}
  }
  async function check(){
    const next=locationKey();
    if(next!==key){key=next;const token=++epoch;segments=[];ignored.clear();reported.clear();submissions.clear();busy=false;lastSkip=null;if(!host)mount();host.hidden=!key;list.replaceChildren();undo.hidden=true;button.disabled=false;
      if(key){try{cfg=await send({type:'settings'});if(token!==epoch)return;status.textContent=cfg.enabled?(cfg.autoAnalyze?'准备查询广告':'自动查询已关闭，可点击重新识别'):'插件已停用，请到设置开启';if(cfg.autoAnalyze)analyze();}catch(e){if(token===epoch)status.textContent=e.message;}}
    }
    const v=document.querySelector('video');if(v!==video){video?.removeEventListener('timeupdate',tick);video=v;video?.addEventListener('timeupdate',tick);}
  }
  chrome.runtime.onMessage.addListener(msg=>{
    if(msg.type==='progress'&&msg.key===key&&busy)status.textContent=msg.text;
    if(msg.type==='settingsChanged'&&key){
      const token=++epoch;segments=[];busy=false;lastSkip=null;undo.hidden=true;button.disabled=false;render();
      send({type:'settings'}).then(s=>{if(token!==epoch)return;cfg=s;status.textContent=s.enabled?'设置已更新':'插件已停用';if(s.autoAnalyze)analyze();}).catch(e=>{if(token===epoch)status.textContent=e.message;});
    }
  });
  // 通过 background 获取公开配置；API Key 永远不暴露给 content script。
  setInterval(check,1000);check();
  window.addEventListener('focus',async()=>{const token=epoch;try{const next=await send({type:'settings'});if(token===epoch)cfg=next;}catch{}});
})();
