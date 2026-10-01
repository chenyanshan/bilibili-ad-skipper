import test from 'node:test';import assert from 'node:assert/strict';
import {createUsageTracker} from '../extension/usage.js';
const p={url:'https://api.typesafe.ai/v1/systemone',key:'local-test-secret',model:'jev-latest'};
function setup(){let time=Date.UTC(2026,9,1);const data={};const storage={get:async key=>({[key]:structuredClone(data[key])}),set:async x=>Object.assign(data,structuredClone(x))};return {data,storage,tracker:createUsageTracker({storage,now:()=>time}),advance:days=>time+=days*86400000};}
const response=()=>({model:'jev-1.13.0',usage:{input_tokens:1e6,output_tokens:500}});
test('并发请求逐次计数，官方模型按输入估算，不记录明文 Key',async()=>{
 const h=setup();await Promise.all(Array.from({length:20},()=>h.tracker.request(p,async()=>response())));
 const u=await h.tracker.summary(p);assert.equal(u.month.requests,20);assert.equal(u.month.input,20e6);assert.equal(u.month.output,10000);assert.ok(Math.abs(u.month.cost-.84)<1e-9);assert.equal(u.month.unpriced,0);assert.ok(!JSON.stringify(h.data).includes(p.key));
});
test('HTTP失败、缺失和畸形用量仍计请求，费用不能凭空补全',async()=>{
 const h=setup();await assert.rejects(h.tracker.request(p,async()=>{throw Error('HTTP 500');}),/500/);
 await h.tracker.request(p,async()=>({usage:{input_tokens:-1,output_tokens:'99'}}));
 await h.tracker.request(p,async()=>({model:'jev-1.13.0',usage:{input_tokens:100}}));
 const u=(await h.tracker.summary(p)).month;assert.equal(u.requests,3);assert.equal(u.unknown,3);assert.equal(u.input,100);assert.equal(u.output,0);assert.equal(u.unpriced,2);assert.ok(Math.abs(u.cost-.0000042)<1e-12);
});
test('不同 Key、接口隔离；自定义服务和未知模型不套用官方价格',async()=>{
 const h=setup();for(const provider of [p,{...p,key:'second'},{...p,url:'https://custom.example/v1/systemone'}])await h.tracker.request(provider,async()=>response());
 assert.equal((await h.tracker.summary(p)).month.requests,1);assert.equal((await h.tracker.summary({...p,url:'https://custom.example/v1/systemone'})).month.unpriced,1);
 await h.tracker.request(p,async()=>({...response(),model:'jev-future'}));assert.equal((await h.tracker.summary(p)).month.unpriced,1);
});
test('24小时、7天、30天滚动窗口精确边界；跨午夜不清零且重启保留',async()=>{
 const h=setup();await h.tracker.request(p,async()=>response());h.advance(.5);await h.tracker.request(p,async()=>response());
 h.advance(.5);let u=await h.tracker.summary(p);assert.equal(u.day.requests,1);assert.equal(u.week.requests,2); // exactly 24h excluded
 h.advance(6);u=await h.tracker.summary(p);assert.equal(u.day.requests,0);assert.equal(u.week.requests,1);
 h.advance(23);u=await h.tracker.summary(p);assert.equal(u.month.requests,1);assert.equal(u.month.input,1e6);
 const restarted=createUsageTracker({storage:h.storage,now:()=>Date.UTC(2026,9,31)});assert.deepEqual(await restarted.summary(p),u);
 h.advance(.5);assert.equal((await h.tracker.summary(p)).month.requests,0);
 const midnight=setup();midnight.advance(.99);await midnight.tracker.request(p,async()=>response());midnight.advance(.02);assert.equal((await midnight.tracker.summary(p)).day.requests,1);
});
test('旧版每日汇总不混入精确滚动窗口',async()=>{
 const h=setup();await h.tracker.request(p,async()=>response());const key=Object.keys(h.data)[0];h.data[key.replace('v2:','')]=[{day:20727,requests:99,input:99e6}];
 assert.equal((await h.tracker.summary(p)).month.requests,1);
});
test('统计写入失败不阻止广告识别结果返回',async()=>{
 const tracker=createUsageTracker({storage:{get:async()=>({}),set:async()=>{throw Error('quota');}}});assert.deepEqual(await tracker.request(p,async()=>response()),response());
});
