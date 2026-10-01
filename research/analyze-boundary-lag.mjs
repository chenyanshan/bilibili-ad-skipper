// Replays saved real JEV responses, never issues API requests or reads keys.
// Community annotations are used only AFTER model execution for comparison.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DEFAULTS, normalizeBody} from '../extension/core.js';
import {execFileSync} from 'node:child_process';
import os from 'node:os';import path from 'node:path';import {pathToFileURL} from 'node:url';
// These recordings predate prefix review: replay against their frozen baseline.
const sourceRef='868d8fc0258e4801dbba572df22f808534605975';
const baseline=fs.mkdtempSync(path.join(os.tmpdir(),'jev-baseline-'));
process.on('exit',()=>fs.rmSync(baseline,{recursive:true,force:true}));
fs.writeFileSync(path.join(baseline,'package.json'),'{"type":"module"}');
for(const file of ['core.js','providers.js','jev-analysis.js'])fs.writeFileSync(path.join(baseline,file),execFileSync('git',['show',`${sourceRef}:extension/${file}`]));
const {analyzeJev}=await import(pathToFileURL(path.join(baseline,'jev-analysis.js')));
const date='2026-10-01';
const corpus=JSON.parse(fs.readFileSync(`research/private-comparison-corpus-${date}.json`));
const saved=JSON.parse(fs.readFileSync(`research/private-comparison-jev-full-${date}.json`));
const rows=[],replayed=[];
const overlap=(a,b)=>Math.max(0,Math.min(a[1],b[1])-Math.max(a[0],b[0]));
for(const old of saved){
 const video=corpus.find(v=>v.bvid===old.bvid&&String(v.cid)===String(old.cid));
 assert(video);let call=0;
 const result=await analyzeJev({rows:normalizeBody(video.body),model:old.model,title:video.title+' '+(video.partTitle||video.title),brands:DEFAULTS.brandHints,threshold:old.threshold,duration:video.duration,ask:async body=>{
  const recorded=old.calls[call++];assert(recorded?.reply,'missing recorded reply');
  assert.deepEqual(Object.keys(body.questions),recorded.phase);
  assert.deepEqual(body.state.eligible_subtitles.map(r=>r[0]),recorded.rowIds);
  return structuredClone(recorded.reply);
 }});
 assert.equal(call,old.calls.length);assert.deepEqual(result.segments,old.segments);
 replayed.push({bvid:old.bvid,originalStartedAt:old.startedAt,requestsReplayed:call,status:result.analysisStatus,isControl:old.isControl});
 if(old.isControl)continue;
 for(const mark of video.community.filter(c=>String(c.cid)===String(video.cid)&&c.category==='sponsor'&&c.actionType==='skip')){
  const ref=mark.segment;
  const best=[...result.segments].sort((a,b)=>overlap(ref,[b.start,b.end])-overlap(ref,[a.start,a.end]))[0];
  const matched=best&&overlap(ref,[best.start,best.end])>0;
  const between=matched?video.body.filter(s=>s.to>ref[0]&&s.from<best.start):[];
  const round=x=>Math.round(x*1000)/1000;
  rows.push({bvid:video.bvid,cid:String(video.cid),votes:mark.votes,communityStart:ref[0],communityEnd:ref[1],matched:!!matched,
   jevStart:matched?best.start:null,jevEnd:matched?best.end:null,startDelta:matched?round(best.start-ref[0]):null,endDelta:matched?round(best.end-ref[1]):null,
   boundaryConfidence:matched?best.boundaryConfidence:null,eligibleToSkip:matched?(!best.truncated&&best.confidence>=old.threshold&&best.end-best.start>=old.minDuration):false,
   subtitleRowsBeforeJev:between.length,analysisStatus:result.analysisStatus,
   originalRunAt:old.startedAt});
 }
}
const matched=rows.filter(r=>r.matched),starts=matched.map(r=>r.startDelta).sort((a,b)=>a-b),ends=matched.map(r=>r.endDelta);
const median=xs=>xs.length?(xs[Math.floor((xs.length-1)/2)]+xs[Math.ceil((xs.length-1)/2)])/2:null;
const auto=matched.filter(r=>r.eligibleToSkip), autoStarts=auto.map(r=>r.startDelta).sort((a,b)=>a-b);
const result={sourceRef,method:'Frozen v0.6.1 baseline replay of saved real JEV API responses; no fresh API calls; community only in post-hoc comparison',date,
 sourceHashes:Object.fromEntries(['core.js','providers.js','jev-analysis.js'].map(n=>[n,createHash('sha256').update(fs.readFileSync(path.join(baseline,n))).digest('hex')])),
 replayedVideos:replayed.length,controlVideos:replayed.filter(r=>r.isControl).length,communitySegments:rows.length,matchedSegments:matched.length,
 medianStartDelta:median(starts),lateOverHalfSecond:starts.filter(v=>v>.5).length,lateOverTwoSeconds:starts.filter(v=>v>2).length,lateOverFiveSeconds:starts.filter(v=>v>5).length,
 bothBoundariesWithinHalfSecond:matched.filter(r=>Math.abs(r.startDelta)<=.5&&Math.abs(r.endDelta)<=.5).length,
 bothBoundariesWithinOneSecond:matched.filter(r=>Math.abs(r.startDelta)<=1&&Math.abs(r.endDelta)<=1).length,
 automaticSegments:auto.length,automaticMedianStartDelta:median(autoStarts),originalRuns:replayed,rows};
fs.writeFileSync(`research/jev-boundary-lag-${date}.json`,JSON.stringify(result,null,2)+'\n');
const quote=v=>'"'+String(v??'').replaceAll('"','""')+'"';
fs.writeFileSync(`research/jev-boundary-lag-${date}.csv`,[Object.keys(rows[0]),...rows.map(r=>Object.values(r))].map(row=>row.map(quote).join(',')).join('\n')+'\n');
console.log(JSON.stringify(Object.fromEntries(Object.entries(result).filter(([k])=>!['sourceHashes','originalRuns','rows'].includes(k))),null,2));
