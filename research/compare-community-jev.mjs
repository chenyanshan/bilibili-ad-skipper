// Local study runner. Supply JEV_API_KEY in the process environment; never writes it.
// Inputs/results are private-*.json and must remain untracked.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {DEFAULTS,normalizeBody,planAnalysis,sponsorContext,touchesBoundary,budgetChunks,compactRows,mergeSegments} from '../extension/core.js';
import {analyzeJev} from '../extension/jev-analysis.js';
import {detectWithJev,jevEndpoint} from '../extension/providers.js';
const date=process.argv[2]||'2026-10-01';
if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw Error('Date must be YYYY-MM-DD');
const sourceHashes=Object.fromEntries(['core.js','providers.js','jev-analysis.js'].map(name=>[name,createHash('sha256').update(fs.readFileSync(new URL('../extension/'+name,import.meta.url))).digest('hex')]));
const key=process.env.JEV_API_KEY;if(!key)throw Error('JEV_API_KEY is required (do not put it in source files).');
const corpus=JSON.parse(fs.readFileSync(`research/private-comparison-corpus-${date}.json`));
const mode=process.env.JEV_STUDY_MODE||'full';
if(!['full','baseline'].includes(mode))throw Error('Invalid study mode');
const output=`research/private-comparison-jev-${mode}-${date}.json`;
const selected=process.env.JEV_STUDY_IDS?.split(',');
const results=fs.existsSync(output)?JSON.parse(fs.readFileSync(output)):[];
for(const video of corpus){
 if(selected&&!selected.includes(video.bvid))continue;
 if(results.some(x=>x.bvid===video.bvid&&x.cid===video.cid&&x.status==='complete'))continue;
 const community=video.community.filter(s=>String(s.cid)===video.cid&&s.category==='sponsor');
 if((!community.length&&!video.isControl)||!video.body||video.body.length<5)continue;
 const rows=normalizeBody(video.body),{parts,stats}=planAnalysis(rows,true,video.duration,DEFAULTS.brandHints);
 const result={bvid:video.bvid,cid:video.cid,title:video.title,startedAt:new Date().toISOString(),model:process.env.JEV_MODEL||DEFAULTS.jevModel,threshold:DEFAULTS.jevThreshold,economy:true,minDuration:DEFAULTS.minDuration,mode,sourceHashes,isControl:video.isControl===true,stats,calls:[],segments:[],status:'running'};
 let incomplete=0;const found=[];
 try{
 if(mode==='full'){
  const analysis=await analyzeJev({rows,model:result.model,title:video.title+' '+(video.partTitle||video.title),brands:DEFAULTS.brandHints,threshold:result.threshold,duration:video.duration,ask:async body=>{
   const call={at:new Date().toISOString(),phase:Object.keys(body.questions),rowIds:body.state.eligible_subtitles.map(x=>x[0])};result.calls.push(call);
   const response=await fetch(jevEndpoint(process.env.JEV_BASE_URL||DEFAULTS.jevBaseUrl),{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},body:JSON.stringify(body),signal:AbortSignal.timeout(25000),redirect:'error'});call.httpStatus=response.status;if(!response.ok)throw Error(`HTTP ${response.status}`);const reply=await response.json();call.reply=reply;return reply;
  }});
  Object.assign(result,analysis);result.status='complete';result.eligibleToSkip=result.segments.filter(s=>!s.truncated&&s.confidence>=result.threshold&&s.end-s.start>=result.minDuration);
 }else{
 if(parts.length>24)throw Error('Too many chunks');
 async function classify(part){return detectWithJev({rows:part,model:result.model,title:video.title+' '+(video.partTitle||video.title),context:sponsorContext(rows),brands:DEFAULTS.brandHints,threshold:result.threshold,duration:video.duration,ask:async body=>{
 if(result.calls.length>=24)throw Error('24 request budget reached');
 const call={at:new Date().toISOString(),phase:Object.keys(body.questions),rowIds:body.state.eligible_subtitles.map(x=>x[0])};result.calls.push(call);
 const response=await fetch(jevEndpoint(process.env.JEV_BASE_URL||DEFAULTS.jevBaseUrl),{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},body:JSON.stringify(body),signal:AbortSignal.timeout(25000),redirect:'error'});call.httpStatus=response.status;if(!response.ok)throw Error(`HTTP ${response.status}`);const reply=await response.json();call.reply=reply;return reply;
 }})}
 for(let i=0;i<parts.length;i++){
 const part=parts[i],detected=await classify(part),edges=detected.filter(s=>touchesBoundary(s,part,rows));found.push(...detected.filter(s=>!touchesBoundary(s,part,rows)));
 if(edges.length){const expanded=rows.filter(r=>r.to>part[0].from-60&&r.from<part.at(-1).to+60);if(budgetChunks(expanded).length===1&&result.calls.length+(parts.length-i-1)<24){stats.sentChars+=JSON.stringify(compactRows(expanded)).length;const retried=await classify(expanded);incomplete+=retried.filter(s=>touchesBoundary(s,expanded,rows)).length;found.push(...retried.filter(s=>!touchesBoundary(s,expanded,rows)))}else incomplete+=edges.length}
 }
 const merged=mergeSegments(found);result.segments=merged.filter(s=>s.end-s.start<=240&&s.end-s.start<video.duration*.95);incomplete+=merged.length-result.segments.length;result.incomplete=incomplete;result.status='complete';result.eligibleToSkip=result.segments.filter(s=>!s.truncated&&s.confidence>=result.threshold&&s.end-s.start>=result.minDuration);
 }
 }catch(error){result.status='error';result.error=String(error.message).split(key).join('[redacted]');result.partialSegments=found}
 result.finishedAt=new Date().toISOString();results.push(result);fs.writeFileSync(output,JSON.stringify(results,null,2));console.log(JSON.stringify({bvid:result.bvid,status:result.status,calls:result.calls.length,segments:result.segments,error:result.error}));
 if(result.error==='HTTP 401'||result.error==='HTTP 403'||result.error==='HTTP 429')break;
}
