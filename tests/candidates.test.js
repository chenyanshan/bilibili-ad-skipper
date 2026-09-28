import test from 'node:test';import assert from 'node:assert/strict';
import {normalizeBody,planAnalysis,candidateWindows,budgetChunks,parseResult,touchesBoundary} from '../extension/core.js';
const make=(texts,start=600)=>normalizeBody(texts.map((content,i)=>({from:start+i*3,to:start+i*3+3,content})));
// 来自 2026-09-28 抓取的真实字幕；短摘录仅用于召回回归，不把关键词当广告判定。
test('真实断句：感谢品牌 / 支持我们到这里',()=>{
 const rows=make(['非常感谢凯迪拉克全新混动XT5','支持我们到这里','那这次我们驾乘体验真的非常棒']);assert.equal(candidateWindows(rows).length,1);
});
test('真实软植入：无赞助关键词的产品功效描述',()=>{
 const rows=make(['它可以一次性搞定油痒屑','痘臭等各种头皮困扰','帮助平衡头皮微生态','调节皮脂','修护头皮屏障','解决瘙痒问题','使用后头皮清爽舒适']);assert.equal(candidateWindows(rows).length,1);
});
test('真实正片用词：下载作弊工具不应独立召回',()=>{
 assert.equal(candidateWindows(make(['不过如果你事先下载作弊工具','然后开挂','提前进入这个房间'])).length,0);
});
test('短视频全量检查，避免省少量输入漏掉长广告',()=>{
 const rows=make(['没有任何营销关键词','依旧需要检查'],0);const p=planAnalysis(rows,true,300);assert.equal(p.stats.mode,'short-full');assert.equal(p.stats.selectedRows,2);
});
test('三分钟视频中的两分钟广告允许跳过，整片仍受保护',()=>{
 const rows=normalizeBody(Array.from({length:60},(_,i)=>({from:i*3,to:i*3+3,content:'字幕'})));
 const segments=[{start_id:10,end_id:49,category:'sponsor',confidence:.98}];assert.equal(parseResult(JSON.stringify({segments}),rows,180)[0].end,150);
 assert.equal(parseResult(JSON.stringify({segments:[{...segments[0],start_id:0,end_id:59}]}),rows,180).length,0);
});
test('长字幕分批有体积上限且不遗漏行',()=>{
 const rows=make(Array.from({length:60},()=> '字'.repeat(500)));const parts=budgetChunks(rows);
 assert.deepEqual([...new Set(parts.flat().map(r=>r.id))],rows.map(r=>r.id));for(const p of parts)assert.ok(JSON.stringify(p.map(r=>[r.id,r.content])).length<=6002);
});
test('候选边缘结果需要扩展确认，真实视频起止不误报为截断',()=>{
 const rows=make(Array.from({length:30},()=> '字幕'));const p=rows.slice(10,20);
 assert.equal(touchesBoundary({start:p[0].from,end:p[3].to},p,rows),true);
 assert.equal(touchesBoundary({start:p[3].from,end:p[6].to},p,rows),false);
 assert.equal(touchesBoundary({start:rows[0].from,end:rows.at(-1).to},rows,rows),false);
});

test('跨片段赞助上下文有限长且保留品牌前句',async()=>{
 const {sponsorContext}=await import('../extension/core.js');const rows=make(['而这次是凯迪拉克全新混动XT5','支持我们来到这里','还搭载了特殊改造的拍摄方案']);const context=sponsorContext(rows);assert.match(context,/凯迪拉克/);assert.ok(context.length<=700);
});

test('用户品牌含 ASR 别字，仅产生候选，不直接标记广告',()=>{
 assert.equal(candidateWindows(make(['这个转转的官方验服务','可以先验货再购买'])).length,1);
 assert.equal(candidateWindows(make(['这款秒界按摩仪','适合放松一下'])).length,1);
 assert.equal(candidateWindows(make(['这里讨论自定义品牌XYZ']), '品牌XYZ').length,1);
 assert.equal(candidateWindows(make(['这里讨论自定义品牌XYZ']), '').length,0);
});
