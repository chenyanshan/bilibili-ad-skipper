import test from 'node:test';
import assert from 'node:assert/strict';
import {createCommunityClient, COMMUNITY_ORIGIN, COMMUNITY_PROJECT_URL} from '../extension/community.js';
const video = {bvid:'BV1234567890', cid:'123', duration:300};
const candidate = {start:30,end:60,confidence:.90,boundaryConfidence:.90,autoSubmitEligible:true};
function setup() {
  const saved = {}, calls = [], replies = [];
  const storage = {
    async get(key) { return {[key]:structuredClone(saved[key])}; },
    async set(data) { Object.assign(saved,structuredClone(data)); },
    async remove(key) { delete saved[key]; },
  };
  let time = 1000000000;
  const fetch = async (url, options) => {
    calls.push({url,options});
    const reply = replies.shift();
    if (reply instanceof Error) throw reply;
    if (typeof reply === 'function') return reply();
    if (!reply) throw Error('No mock reply');
    return {status:reply.status,ok:reply.status>=200&&reply.status<300,text:async()=> typeof reply.body==='string'?reply.body:JSON.stringify(reply.body)};
  };
  const client = createCommunityClient({fetch,storage,now:()=>time,version:'0.3.0'});
  return {client,saved,calls,replies,storage,fetch,advance:ms=>{time+=ms;}};
}
const empty = () => ({status:404,body:''});
const apiSegment = overrides => ({cid:'123',category:'sponsor',actionType:'skip',segment:[10,40],UUID:'uuid1234',...overrides});
const found = segments => ({status:200,body:[{videoID:video.bvid,segments}]});
const success = () => ({status:200,body:[{UUID:'server_uuid1234'}]});

test('fixed community source; sponsor filtering happens before playable intervals', async () => {
  const {client,replies,calls} = setup();
  replies.push(found([apiSegment({category:'intro'}),apiSegment({cid:'456'}),apiSegment()]));
  const result = await client.lookup(video);
  assert.equal(result.status,'found'); assert.equal(result.segments.length,1);
  assert.equal(result.segments[0].source,'community');
  assert.match(calls[0].url,new RegExp(`^${COMMUNITY_ORIGIN}/api/skipSegments/[a-f0-9]{4}$`));
  assert.equal(calls[0].options.credentials,'omit'); assert.equal(calls[0].options.redirect,'error');
  assert.ok(calls[0].options.signal); assert.match(COMMUNITY_PROJECT_URL,/hanydd\/BilibiliSponsorBlock$/);
});
test('non-sponsor or other CID/BV alone does not block AI', async () => {
  const {client,replies} = setup();
  replies.push(found([apiSegment({category:'selfpromo'}),apiSegment({cid:'999'})]));
  assert.equal((await client.lookup(video)).status,'empty');
  replies.push({status:200,body:[{videoID:'BV0987654321',segments:[apiSegment()]}]});
  assert.equal((await client.lookup(video,{force:true})).status,'empty');
});
test('full, mute, invalid sponsor ranges block AI but never skip full video', async () => {
  for (const segment of [apiSegment({actionType:'full',segment:[0,0]}),apiSegment({actionType:'mute'}),apiSegment({segment:[70,10]})]) {
    const {client,replies}=setup(); replies.push(found([segment]));
    const result=await client.lookup(video); assert.equal(result.hasAd,true); assert.deepEqual(result.segments,[]);
    assert.equal(result.hasFullVideoAd,segment.actionType==='full');
  }
});
test('only valid empty 200 and 404 are empty; failures do not poison cache', async () => {
  const {client,replies,saved}=setup(); replies.push(empty());
  assert.equal((await client.lookup(video)).status,'empty'); const cache=structuredClone(saved['community:cache']);
  for(const response of [{status:500,body:'secret-key'}, {status:200,body:{}}, found([{bad:true}]),new Error('secret-key')]) {
    replies.push(response); const result=await client.lookup(video,{force:true});
    assert.equal(result.status,'unavailable'); assert.ok(!JSON.stringify(result).includes('secret-key'));
    assert.deepEqual(saved['community:cache'],cache);
  }
});
test('cache TTL and force requests honor current video identity', async () => {
  const {client,replies,calls,advance}=setup(); replies.push(empty()); await client.lookup(video);
  await client.lookup(video); assert.equal(calls.length,1);
  replies.push(found([apiSegment()])); assert.equal((await client.lookup(video,{force:true})).hasAd,true);
  assert.equal(calls[1].options.headers['X-SKIP-CACHE'],'1');
  advance(3600001); replies.push(empty()); assert.equal((await client.lookup(video)).status,'empty');
});
test('JEV inclusive .90 boundary and immutable allowlisted POST body', async () => {
  const {client,replies,calls,saved}=setup(); replies.push(empty(),success());
  const v={...video}, segment={...candidate,apiKey:'must-not-upload',subtitles:['private']};
  const promise=client.submit(v,segment,{automatic:true}); v.bvid='BV0987654321'; segment.start=99;
  assert.equal((await promise).status,'submitted');
  const post=calls.find(call=>call.options.method==='POST'), body=JSON.parse(post.options.body);
  assert.equal(body.videoID,video.bvid); assert.deepEqual(body.segments,[{segment:[30,60],category:'sponsor',actionType:'skip'}]);
  assert.equal(body.userAgent,'bilibili-ad-skipper/0.3.0'); assert.match(body.userID,/^[a-f0-9]{64}$/);
  assert.ok(!post.options.body.includes('must-not-upload')); assert.ok(!post.options.body.includes('private'));
  assert.equal(saved['community:attempts'][0].state,'submitted');
});
test('LLM automatic or uncertain JEV blocked before network; LLM manual permitted', async () => {
  const {client,replies,calls}=setup();
  for(const [segment,provider] of [[candidate,'llm'],[{...candidate,confidence:.899},'jev'],[{...candidate,boundaryConfidence:NaN},'jev'],[{...candidate,truncated:true},'jev'],[{...candidate,autoSubmitEligible:false},'jev']]) {
    assert.equal((await client.submit(video,segment,{automatic:true,provider})).status,'blocked');
  }
  assert.equal(calls.length,0); replies.push(empty(),success());
  assert.equal((await client.submit(video,candidate,{provider:'llm'})).status,'submitted');
});
test('upload forces fresh community check and any sponsor blocks', async () => {
  const {client,replies,calls}=setup(); replies.push(empty()); await client.lookup(video);
  replies.push(found([apiSegment({actionType:'mute'})]));
  assert.equal((await client.submit(video,candidate)).status,'duplicate'); assert.equal(calls.length,2);
  assert.ok(!calls.some(c=>c.options.method==='POST'));
});
test('automatic failures persist attempts before POST, manual explicit retry allowed', async () => {
  const {client,replies,saved,calls}=setup(); replies.push(empty(),{status:503,body:'secret-key'});
  const failed=await client.submit(video,candidate,{automatic:true}); assert.equal(failed.status,'error');
  assert.ok(!JSON.stringify(failed).includes('secret-key')); assert.equal(saved['community:attempts'][0].state,'attempted');
  replies.push(empty()); assert.equal((await client.submit(video,candidate,{automatic:true})).status,'blocked');
  replies.push(empty(),success()); assert.equal((await client.submit(video,candidate)).status,'submitted');
  replies.push(empty()); assert.equal((await client.submit(video,candidate)).status,'duplicate');
  assert.equal(calls.filter(c=>c.options.method==='POST').length,2);
});
test('invalid success receipts never mark submitted and retain local ledger', async () => {
  for(const body of [[],{},[{UUID:''}], [{UUID:'bad key with spaces'}], 'not-json']) {
    const {client,replies,saved}=setup(); replies.push(empty(),{status:200,body});
    assert.equal((await client.submit(video,candidate)).status,'error');
    assert.equal(saved['community:attempts'][0].state,'attempted');
  }
});
test('clients sharing background storage serialize cross-tab attempts', async () => {
  const {client,replies,storage,fetch,calls}=setup();
  const second=createCommunityClient({fetch,storage,now:()=>1000000000,version:'0.3.0'});
  replies.push(empty(),success(),empty());
  const result=await Promise.all([client.submit(video,candidate,{automatic:true}),second.submit(video,{...candidate,start:35},{automatic:true})]);
  assert.deepEqual(result.map(r=>r.status),['submitted','duplicate']);
  assert.equal(calls.filter(c=>c.options.method==='POST').length,1);
});
test('attempt persistence failure forbids network POST', async () => {
  const {client,replies,storage,calls}=setup();
  const original=storage.set;storage.set=async data=>{if(data['community:attempts'])throw Error('secret-key');await original(data);};
  replies.push(empty());assert.equal((await client.submit(video,candidate)).status,'error');
  assert.equal(calls.filter(c=>c.options.method==='POST').length,0);
});
test('revalidate current video after awaited lookup and persistence before POST', async () => {
  const {client,replies,calls,saved}=setup(); replies.push(empty());
  let checked=false;
  const result=await client.submit(video,candidate,{automatic:true,isCurrent:async()=>{
    checked=true;assert.equal(saved['community:attempts'][0].state,'attempted');return false;
  }});
  assert.equal(result.status,'blocked');assert.ok(checked);assert.equal(calls.filter(c=>c.options.method==='POST').length,0);
});
test('lookup cache is bounded at 100 entries', async () => {
  const {client,replies,saved}=setup();
  for(let cid=1;cid<=105;cid++) {replies.push(empty());await client.lookup({...video,cid});}
  assert.equal(saved['community:cache'].length,100);
});
test('attempt ledger expires after seven days and is bounded at 500 entries', async () => {
  const {client,replies,saved,advance}=setup();
  saved['community:attempts']=Array.from({length:505},(_,i)=>({video:`${video.bvid}:${1000+i}`,start:1,end:2,time:1000000000,state:'attempted'}));
  replies.push(empty(),success());assert.equal((await client.submit(video,candidate)).status,'submitted');
  assert.equal(saved['community:attempts'].length,500);
  advance(7*86400000+1);replies.push(empty(),success());
  assert.equal((await client.submit(video,candidate,{automatic:true})).status,'submitted');
  assert.equal(saved['community:attempts'].length,1);
});
test('community video duration accepts unknown 0 and ±2 seconds, rejects expired timing', async () => {
  for (const [duration, playable] of [[0,true],[298,true],[302,true],[297.99,false],[302.01,false],['300',false]]) {
    const {client,replies}=setup(); replies.push(found([apiSegment({videoDuration:duration})]));
    const result=await client.lookup(video);
    assert.equal(result.hasAd,true); assert.equal(result.segments.length,playable?1:0);
  }
});
test('POST parameter, moderation and rate failures show fixed HTTP reasons without server text', async () => {
  for (const status of [400,403,429]) {
    const {client,replies,saved}=setup(); replies.push(empty(),{status,body:'private-server-error-secret-key'});
    const result=await client.submit(video,candidate);
    assert.equal(result.status,'error'); assert.ok(result.message.includes(`HTTP ${status}`));
    assert.ok(!result.message.includes('private-server-error')); assert.ok(!result.message.includes('secret-key'));
    assert.equal(saved['community:attempts'][0].state,'attempted');
  }
});
test('optional category and timestamps in successful receipt must match the submitted advertisement', async () => {
  for (const receipt of [
    {UUID:'server_uuid1234',category:'intro'},
    {UUID:'server_uuid1234',segment:[30,61]},
    {UUID:'server_uuid1234',segment:['30',60]},
    {UUID:'server_uuid1234',segment:null},
  ]) {
    const {client,replies,saved}=setup();replies.push(empty(),{status:200,body:[receipt]});
    assert.equal((await client.submit(video,candidate)).status,'error');
    assert.equal(saved['community:attempts'][0].state,'attempted');
  }
  const {client,replies}=setup();
  replies.push(empty(),{status:200,body:[{UUID:'server_uuid1234',category:'sponsor',segment:[30,60]}]});
  assert.equal((await client.submit(video,candidate)).status,'submitted');
});
