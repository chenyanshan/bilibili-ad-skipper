// Shared classic content script; runs in Chrome's isolated extension world.
// Timers track media time, never change the source interval or seek early.
globalThis.createAdSkipScheduler = function ({getState,onDue,
  setTimer=setTimeout,clearTimer=clearTimeout,
  requestFrame=requestAnimationFrame,cancelFrame=cancelAnimationFrame}) {
  let timer=null,frame=null,generation=0,disposed=false;
  function cancel(){generation++;if(timer!==null)clearTimer(timer);if(frame!==null)cancelFrame(frame);timer=frame=null;}
  function active(s){return s?.enabled&&s.video&&!s.video.paused&&!s.video.seeking&&!s.video.ended&&s.video.playbackRate>0;}
  function refresh(){
    cancel();if(disposed)return;
    let s=getState();if(!active(s))return;
    const due=s.segments.some(x=>s.video.currentTime>=x.start&&s.video.currentTime<x.end-.2);
    if(due){onDue();s=getState();if(!active(s))return;}
    const next=s.segments.filter(x=>Number.isFinite(x.start)&&Number.isFinite(x.end)&&x.end-.2>s.video.currentTime).sort((a,b)=>a.start-b.start)[0];
    if(!next)return;
    const ms=Math.max(0,(next.start-s.video.currentTime)/s.video.playbackRate*1000),token=generation;
    const wake=()=>{if(!disposed&&token===generation)refresh();};
    // Near the boundary, both frames and a timer run: hidden tabs may suppress frames.
    // Long waits are rechecked each second for stalls and media-clock drift.
    timer=setTimer(wake,ms<=250?Math.max(4,Math.min(25,ms)):Math.min(1000,ms-200));
    if(ms<=250)frame=requestFrame(wake);
  }
  return {refresh,cancel,dispose(){disposed=true;cancel();}};
};
