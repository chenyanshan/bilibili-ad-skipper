(()=>{
  let key='',epoch=0,segments=[],ignored=new Set(),cfg={},busy=false,video=null,host,root,status,list,button,undo,lastSkip=null;
  const send=async msg=>{const r=await chrome.runtime.sendMessage(msg);if(!r?.ok)throw Error(r?.error||'插件连接失败，请刷新页面');return r.result;};
  const time=n=>`${Math.floor(n/60)}:${String(Math.floor(n%60)).padStart(2,'0')}`;
  function mount(){
    host=document.createElement('div');host.id='bili-ad-skipper';root=host.attachShadow({mode:'closed'});
    root.innerHTML=`<style>:host{position:fixed;right:18px;bottom:76px;z-index:2147483000;font:13px/1.5 system-ui;color:#e8edf4}details{width:270px;background:#17202eee;border:1px solid #475569;border-radius:12px;box-shadow:0 8px 28px #0004;padding:12px}summary{cursor:pointer;font-weight:650}p{margin:10px 0;overflow-wrap:anywhere}button{background:#334155;color:#fff;border:1px solid #64748b;border-radius:6px;padding:5px 9px;cursor:pointer;margin:3px 4px 3px 0}button:hover{background:#475569}button:disabled{opacity:.5;cursor:wait}.row{border-top:1px solid #475569;padding:8px 0}#list{max-height:220px;overflow:auto}.muted{color:#b6c5d8;font-size:12px}[hidden]{display:none!important}</style><details><summary>广告跳过</summary><p id="status">就绪</p><button id="analyze">重新识别</button><button id="settings">设置</button><button id="undo" hidden>撤销跳过</button><div id="list"></div><p class="muted">自动识别会将字幕发送到你配置的 AI 接口。</p></details>`;
    document.documentElement.append(host);status=root.querySelector('#status');list=root.querySelector('#list');button=root.querySelector('#analyze');undo=root.querySelector('#undo');
    button.onclick=()=>analyze(true);root.querySelector('#settings').onclick=()=>send({type:'options'}).catch(e=>status.textContent=e.message);
    undo.onclick=()=>{if(lastSkip&&video){ignored.add(lastSkip.index);video.currentTime=lastSkip.from;status.textContent='已恢复播放，本次不再自动跳过该片段';lastSkip=null;undo.hidden=true;}};
  }
  function render(){
    list.replaceChildren();segments.forEach((s,i)=>{
      const row=document.createElement('div');row.className='row';
      const text=document.createElement('div');text.textContent=`${time(s.start)}–${time(s.end)} · ${Math.round(s.confidence*100)}% · ${s.reason}`;
      const jump=document.createElement('button');jump.textContent='跳过';jump.onclick=()=>{if(video)skip(i);};
      const keep=document.createElement('button');keep.textContent=ignored.has(i)?'已保留':'保留片段';keep.onclick=()=>{ignored.add(i);render();};row.append(text,jump,keep);list.append(row);
    });
  }
  function skip(index){const s=segments[index];lastSkip={index,from:video.currentTime};video.currentTime=Math.min(s.end,Number.isFinite(video.duration)?video.duration:s.end);undo.hidden=false;root.querySelector('details').open=true;status.textContent=`已跳过 ${time(s.start)}–${time(s.end)}，可撤销`;}
  function tick(){if(!cfg.enabled||!cfg.autoSkip||!video||video.paused||video.seeking)return;const i=segments.findIndex((s,i)=>!ignored.has(i)&&s.confidence>=cfg.threshold&&s.end-s.start>=(cfg.minDuration??20)&&video.currentTime>=s.start&&video.currentTime<s.end-0.2);if(i>=0)skip(i);}
  async function analyze(force=false){
    if(busy||!cfg.enabled)return;const token=epoch,current=key;busy=true;button.disabled=true;status.textContent='读取字幕…';
    try{const result=await send({type:'analyze',key:current,force});if(token!==epoch)return;segments=result.segments;ignored.clear();render();status.textContent=segments.length?`找到 ${segments.length} 段候选广告${result.cached?'（缓存）':''}；${cfg.autoSkip?`高置信度且 ≥${cfg.minDuration??20} 秒自动跳过`:'手动跳过'}`:(result.stats?.requests===0?'未找到明显广告线索，本次未调用 AI':'候选片段中未确认广告');status.textContent=`${result.provider==='jev'?'JEV':'LLM'} · `+status.textContent;if(result.stats)status.textContent+=` · 筛选 ${result.stats.selectedRows}/${result.stats.totalRows} 条字幕${result.cached?'（复用缓存）':''}`;if(result.incomplete)status.textContent+=' · 部分广告边界不完整，已保留播放';}
    catch(e){if(token===epoch)status.textContent=e.message;}
    finally{if(token===epoch){busy=false;button.disabled=false;}}
  }
  async function check(){
    const bvid=location.pathname.match(/\/video\/(BV[\w]+)/)?.[1];const next=bvid?`${bvid}:${Number(new URL(location.href).searchParams.get('p')||1)}`:'';
    if(next!==key){key=next;const token=++epoch;segments=[];ignored.clear();busy=false;lastSkip=null;if(!host)mount();host.hidden=!key;list.replaceChildren();undo.hidden=true;button.disabled=false;
      if(key){try{cfg=await send({type:'settings'});if(token!==epoch)return;status.textContent=cfg.enabled?(cfg.autoAnalyze?'自动跳过已开启':'自动识别已关闭，可在设置中开启'):'插件已停用，请到设置开启';if(cfg.autoAnalyze)analyze();}catch(e){status.textContent=e.message;}}
    }
    const v=document.querySelector('video');if(v!==video){video?.removeEventListener('timeupdate',tick);video=v;video?.addEventListener('timeupdate',tick);}
  }
  chrome.runtime.onMessage.addListener(msg=>{
    if(msg.type==='progress'&&msg.key===key&&busy)status.textContent=msg.text;
    if(msg.type==='settingsChanged'&&key){
      const token=++epoch;segments=[];ignored.clear();busy=false;lastSkip=null;undo.hidden=true;button.disabled=false;render();
      send({type:'settings'}).then(s=>{if(token!==epoch)return;cfg=s;status.textContent=s.enabled?`${s.provider==='jev'?'JEV':'LLM'} 已就绪`:'插件已停用';if(s.autoAnalyze)analyze();}).catch(e=>{if(token===epoch)status.textContent=e.message;});
    }
  });
  // 通过 background 获取公开配置；API Key 永远不暴露给 content script。
  setInterval(check,1000);check();
  window.addEventListener('focus',async()=>{try{cfg=await send({type:'settings'});}catch{}});
})();
