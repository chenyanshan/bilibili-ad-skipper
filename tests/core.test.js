import test from 'node:test';import assert from 'node:assert/strict';
import {endpoint,normalizeBody,chunks,parseResult,mergeSegments} from '../extension/core.js';
const rows=normalizeBody(Array.from({length:100},(_,i)=>({from:i*3,to:i*3+3,content:'字幕'+i})));
test('接口地址与安全边界',()=>{assert.equal(endpoint('https://example.com/v1/'),'https://example.com/v1/chat/completions');assert.equal(endpoint('https://example.com/v1/chat/completions'),'https://example.com/v1/chat/completions');assert.throws(()=>endpoint('http://evil.com/v1'));assert.throws(()=>endpoint('https://user:secret@example.com'));assert.throws(()=>endpoint('https://example.com?key=foo'));assert.ok(endpoint('http://localhost:8000/v1'));});
test('分块覆盖全部字幕并保留上下文',()=>{const c=chunks(rows,30,5);assert.deepEqual([...new Set(c.flat().map(r=>r.id))],rows.map(r=>r.id));assert.equal(c[0].at(-1).id,29);assert.equal(c[1][0].id,25);});
test('只允许当前字幕范围内的广告边界',()=>{const segments=[{start_id:10,end_id:19,category:'sponsor',confidence:0.97,reason:'优惠码'},{start_id:500,end_id:501,category:'sponsor',confidence:1},{start_id:1,end_id:2,category:'review',confidence:1},{start_id:20,end_id:10,category:'sponsor',confidence:1},{start_id:1,end_id:2,category:'sponsor',confidence:'1'}];assert.deepEqual(parseResult(JSON.stringify({segments}),rows,300),[{start:30,end:60,confidence:.97,reason:'优惠码'}]);});
test('整片广告和无效 JSON 不会触发跳过',()=>{assert.deepEqual(parseResult(JSON.stringify({segments:[{start_id:0,end_id:99,category:'sponsor',confidence:1}]}),rows,300),[]);assert.throws(()=>parseResult('not json',rows,300));assert.throws(()=>parseResult('{}',rows,300));});
test('合并重叠结果取较保守置信度，不合并隔着正片的片段',()=>{assert.deepEqual(mergeSegments([{start:10,end:20,confidence:1},{start:15,end:30,confidence:.9},{start:31,end:40,confidence:1}]),[{start:10,end:30,confidence:.9},{start:31,end:40,confidence:1}]);});

test('不同区间重叠合并不获得新的自动投稿资格，相同边界重复可保留资格',()=>{
 const a={start:10,end:30,confidence:.95,boundaryConfidence:.95,autoSubmitEligible:true};
 const merged=mergeSegments([a,{...a,start:20,end:40}]);assert.equal(merged[0].end,40);assert.equal(merged[0].autoSubmitEligible,false);
 assert.equal(mergeSegments([a,{...a}])[0].autoSubmitEligible,true);
 assert.equal(mergeSegments([a,{...a,autoSubmitEligible:false}])[0].autoSubmitEligible,false);
});
