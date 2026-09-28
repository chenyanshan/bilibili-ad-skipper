// 本地研究语料不随发布包分发。先采集 private-corpus.json，再运行本脚本。
import fs from 'node:fs';
import {normalizeBody,planAnalysis,sponsorContext} from '../extension/core.js';
const corpus=JSON.parse(fs.readFileSync(new URL('./private-corpus.json',import.meta.url)));
for(const video of corpus){
 if(!video.body)continue;
 const rows=normalizeBody(video.body),{stats}=planAnalysis(rows,true,video.duration);
 console.log(JSON.stringify({bvid:video.bvid,title:video.title,...stats,contextChars:sponsorContext(rows).length}));
}
