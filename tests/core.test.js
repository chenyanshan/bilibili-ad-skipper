import test from 'node:test';import assert from 'node:assert/strict';
import {endpoint,normalizeBody,chunks,mergeSegments,normalizeSettings,DEFAULTS} from '../extension/core.js';
const rows=normalizeBody(Array.from({length:100},(_,i)=>({from:i*3,to:i*3+3,content:'字幕'+i})));
test('接口地址与安全边界',()=>{assert.equal(endpoint('https://example.com/v1/'),'https://example.com/v1');assert.throws(()=>endpoint('http://evil.com/v1'));assert.throws(()=>endpoint('https://user:secret@example.com'));assert.throws(()=>endpoint('https://example.com?key=foo'));assert.ok(endpoint('http://localhost:8000/v1'));});
test('分块覆盖全部字幕并保留上下文',()=>{const c=chunks(rows,30,5);assert.deepEqual([...new Set(c.flat().map(r=>r.id))],rows.map(r=>r.id));assert.equal(c[0].at(-1).id,29);assert.equal(c[1][0].id,25);});
test('合并重叠结果取较保守置信度，不合并隔着正片的片段',()=>{assert.deepEqual(mergeSegments([{start:10,end:20,confidence:1},{start:15,end:30,confidence:.9},{start:31,end:40,confidence:1}]),[{start:10,end:30,confidence:.9},{start:31,end:40,confidence:1}]);});

test('不同区间重叠合并不获得新的自动投稿资格，相同边界重复可保留资格',()=>{
 const a={start:10,end:30,confidence:.95,boundaryConfidence:.95,autoSubmitEligible:true};
 const merged=mergeSegments([a,{...a,start:20,end:40}]);assert.equal(merged[0].end,40);assert.equal(merged[0].autoSubmitEligible,false);
 assert.equal(mergeSegments([a,{...a}])[0].autoSubmitEligible,true);
 assert.equal(mergeSegments([a,{...a,autoSubmitEligible:false}])[0].autoSubmitEligible,false);
});

test('旧设置统一 JEV 且保留已有 JEV 与社区配置，丢弃 LLM 字段',()=>{
 const old={...DEFAULTS,provider:'llm',apiKey:'old-secret',baseUrl:'https://legacy.example',model:'old',economy:true,jevApiKey:'local-jev',jevModel:'custom',jevBaseUrl:'https://custom.example',communityEnabled:false};
 const s=normalizeSettings(old);assert.equal(s.provider,'jev');assert.equal(s.jevApiKey,'local-jev');assert.equal(s.jevModel,'custom');assert.equal(s.jevBaseUrl,'https://custom.example');assert.equal(s.communityEnabled,false);assert.ok(!('apiKey' in s));assert.ok(!('economy' in s));assert.equal(old.apiKey,'old-secret');
});
