import test from 'node:test';import assert from 'node:assert/strict';
import {compareVersions,parseRelease,createUpdateChecker,UPDATE_KEY,DAY,RELEASES,LATEST_API} from '../extension/updates.js';
export function release(version='0.7.0'){return {tag_name:'v'+version,html_url:RELEASES+'/tag/v'+version,body:'说明',published_at:'2026-10-01T00:00:00Z',assets:['bilibili-ad-skipper.zip','SHA256SUMS.txt'].map((name,i)=>({id:10+i,name,state:'uploaded',size:100,browser_download_url:RELEASES+'/download/v'+version+'/'+name}))};}
test('numeric versions compare 0.10 above 0.9; malformed and oversized versions rejected',()=>{
 assert.equal(compareVersions('0.10.0','0.9.9'),1);assert.equal(compareVersions('1.0.0','1.0.0'),0);assert.equal(compareVersions('0.6.2','0.7.0'),-1);
 for(const v of ['01.2.3','v1.2.3','1.2','1.2.70000','1.2.3-beta'])assert.throws(()=>compareVersions(v,'1.0.0'));
});
test('only complete releases from the fixed repository are install candidates',()=>{
 assert.equal(parseRelease(release()).version,'0.7.0');
 for(const mutate of [r=>r.draft=true,r=>r.prerelease=true,r=>r.assets.pop(),r=>r.html_url='https://example.com/',r=>r.assets[0].browser_download_url='https://example.com/a.zip',r=>r.assets[0].state='new',r=>r.assets[0].size=1e9]){const r=release();mutate(r);assert.throws(()=>parseRelease(r));}
});
function harness(fetch){let time=2*DAY;const data={},calls=[],badges=[];const storage={get:async key=>({[key]:structuredClone(data[key])}),set:async x=>Object.assign(data,structuredClone(x))};const create=()=>createUpdateChecker({storage,now:()=>time,currentVersion:'0.6.2',fetch:async(...a)=>{calls.push(a);return fetch?fetch(...a):new Response(JSON.stringify(release()));},onChange:async s=>badges.push(s)});return {data,calls,badges,create,advance:ms=>time+=ms};}
test('daily checks persist across workers, manual check throttles, no credentials sent',async()=>{
 const h=harness(),u=h.create();assert.equal((await u.check()).available,true);await h.create().check();assert.equal(h.calls.length,1);h.advance(60001);await u.check(true);assert.equal(h.calls.length,2);h.advance(DAY);await u.check();assert.equal(h.calls.length,3);
 assert.equal(h.calls[0][0],LATEST_API);assert.equal(h.calls[0][1].credentials,'omit');assert.equal(h.calls[0][1].redirect,'error');assert.equal(h.calls[0][1].headers.Authorization,undefined);
});
test('failed requests retain previous release with error, and are throttled',async()=>{
 let fail=false;const h=harness(()=>new Response(fail?'':JSON.stringify(release()),{status:fail?429:200})),u=h.create();await u.check();fail=true;h.advance(DAY);const state=await u.check();assert.equal(state.available,true);assert.match(state.error,/限制/);await h.create().check();assert.equal(h.calls.length,2);
});
test('disabled automatic checks do no network; manual checks still work; pending disable survives',async()=>{
 const h=harness(),u=h.create();await u.setEnabled(false);await u.check();assert.equal(h.calls.length,0);await u.check(true);assert.equal(h.calls.length,1);
 let releaseRequest;const delayed=harness(()=>new Promise(r=>releaseRequest=r)),checker=delayed.create();const p=checker.check();while(!releaseRequest)await new Promise(r=>setImmediate(r));await checker.setEnabled(false);releaseRequest(new Response(JSON.stringify(release())));await p;assert.equal((await checker.status()).enabled,false);
});
test('simultaneous checks share one request; current/newer installed version is not offered as downgrade',async()=>{
 const h=harness();await Promise.all([h.create().check()]);const u=h.create();h.advance(DAY);await Promise.all([u.check(true),u.check(true)]);assert.equal(h.calls.length,2);
 h.data[UPDATE_KEY].release.version='0.6.2';assert.equal((await u.status()).available,false);h.data[UPDATE_KEY].release.version='0.6.1';assert.equal((await u.status()).available,false);
});
