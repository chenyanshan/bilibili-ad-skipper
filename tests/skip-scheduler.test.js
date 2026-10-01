import test from 'node:test';import assert from 'node:assert/strict';
import '../extension/skip-scheduler.js';
function harness({time=0,rate=1,frames=true}={}){
 let wall=0,seq=0;const jobs=new Map(),skips=[];
 const video={currentTime:time,playbackRate:rate,paused:false,seeking:false,ended:false};
 const state={video,enabled:true,segments:[{start:10,end:30}]};
 const put=(fn,delay)=>{const id=++seq;jobs.set(id,{at:wall+delay,fn});return id;};
 const scheduler=createAdSkipScheduler({getState:()=>state,onDue(){skips.push(video.currentTime);video.currentTime=30;},setTimer:put,clearTimer:id=>jobs.delete(id),requestFrame:fn=>put(fn,frames?1000/60:1e9),cancelFrame:id=>jobs.delete(id)});
 function advance(ms){const end=wall+ms;for(let i=0;i<10000;i++){const next=[...jobs].sort((a,b)=>a[1].at-b[1].at)[0];if(!next||next[1].at>end)break;move(next[1].at);jobs.delete(next[0]);next[1].fn();}move(end);}
 function move(to){if(!video.paused&&!video.seeking)video.currentTime+=(to-wall)*video.playbackRate/1000;wall=to;}
 return {state,video,jobs,skips,scheduler,advance};
}
test('skips at known boundary without waiting for timeupdate, never early at 1/2/3x',()=>{
 for(const rate of [1,2,3]){const h=harness({time:9,rate});h.scheduler.refresh();h.advance(1000/rate-1);assert.equal(h.skips.length,0);h.advance(30);assert.equal(h.skips.length,1);assert.ok(h.skips[0]>=10&&h.skips[0]<10.1);assert.equal(h.jobs.size,0);}
});
test('hidden tabs with suppressed animation frames still have timer fallback',()=>{
 const h=harness({time:9.8,rate:2,frames:false});h.scheduler.refresh();h.advance(130);assert.equal(h.skips.length,1);assert.ok(h.skips[0]>=10&&h.skips[0]<10.06);
});
test('new result inside ad triggers immediate check; invalid end does not loop',()=>{
 const h=harness({time:12});h.scheduler.refresh();assert.deepEqual(h.skips,[12]);assert.equal(h.jobs.size,0);
 const tail=harness({time:29.9});tail.scheduler.refresh();assert.equal(tail.skips.length,0);assert.equal(tail.jobs.size,0);
});
test('pause, seek, disable, retain, navigation and dispose cancel pending work',()=>{
 for(const action of ['pause','seek','disable','retain','navigate','dispose']){
 const h=harness({time:9.9});h.scheduler.refresh();
 if(action==='pause')h.video.paused=true;if(action==='seek')h.video.seeking=true;
 if(action==='disable'||action==='navigate')h.state.enabled=false;if(action==='retain')h.state.segments=[];
 action==='dispose'?h.scheduler.dispose():h.scheduler.refresh();h.advance(1000);assert.equal(h.skips.length,0,action);assert.equal(h.jobs.size,0,action);
 }
});
test('rate changes and backward seeks recalculate media deadlines',()=>{
 const h=harness({time:9});h.scheduler.refresh();h.advance(200);h.video.playbackRate=2;h.scheduler.refresh();h.advance(350);assert.equal(h.skips.length,0);h.advance(70);assert.equal(h.skips.length,1);
 const b=harness({time:9.9});b.scheduler.refresh();b.video.currentTime=5;b.scheduler.refresh();b.advance(1000);assert.equal(b.skips.length,0);
});
test('stale queued callbacks cannot seek after cancellation or video replacement',()=>{
 const h=harness({time:9.9});h.scheduler.refresh();const callbacks=[...h.jobs.values()].map(j=>j.fn);h.state.video=null;h.scheduler.refresh();callbacks.forEach(f=>f());assert.equal(h.skips.length,0);assert.equal(h.jobs.size,0);
});
test('no eligible interval creates no playback polling; resume restarts check',()=>{
 const h=harness();h.state.segments=[];h.scheduler.refresh();assert.equal(h.jobs.size,0);
 h.state.segments=[{start:10,end:30}];h.video.paused=true;h.scheduler.refresh();assert.equal(h.jobs.size,0);h.video.paused=false;h.scheduler.refresh();assert.ok(h.jobs.size>0);
});
