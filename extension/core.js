export const DEFAULTS = {provider:'jev', jevBaseUrl:'https://api.typesafe.ai', jevModel:'jev-latest', jevApiKey:'', jevThreshold:0.65, enabled:true, communityEnabled:true, communityAutoSubmit:false, autoSkip:true, autoAnalyze:true, minDuration:20, brandHints:'转转,妙界,秒界'};
export function endpoint(base) {
  const u=new URL(base.trim());
  if(u.username || u.password || u.search || u.hash || !(u.protocol==='https:' || (u.protocol==='http:' && ['localhost','127.0.0.1'].includes(u.hostname)))) throw Error('接口必须为 HTTPS（本机服务可使用 HTTP），且不能包含账号、查询参数或片段');
  u.pathname=u.pathname.replace(/\/+$/,'');
  return u.href;
}
export function normalizeBody(body) {
  if(!Array.isArray(body)) throw Error('字幕格式不正确');
  const rows=body.filter(r=>Number.isFinite(r.from)&&Number.isFinite(r.to)&&r.from>=0&&r.to>r.from&&typeof r.content==='string').sort((a,b)=>a.from-b.from).map((r,i)=>({id:i,from:r.from,to:r.to,content:r.content.slice(0,1500)}));
  if(!rows.length) throw Error('字幕为空');
  if(rows.length>15000) throw Error('字幕过长，请换较短的视频');
  return rows;
}
export function chunks(rows, size=160, overlap=20) {
  const out=[]; for(let i=0;i<rows.length;i+=size-overlap){out.push(rows.slice(i,i+size));if(i+size>=rows.length)break;} return out;
}
export function mergeSegments(segments) {
  const out=[];
  for(const s of [...segments].sort((a,b)=>a.start-b.start)) {
    const last=out.at(-1);
    if(last && s.start<last.end) {
      // Combining different boundary decisions must never create a new auto-upload interval.
      const identical=last.start===s.start&&last.end===s.end;
      if(last.autoSubmitEligible!==undefined||s.autoSubmitEligible!==undefined)last.autoSubmitEligible=identical&&last.autoSubmitEligible===true&&s.autoSubmitEligible===true;
      last.end=Math.max(last.end,s.end);last.confidence=Math.min(last.confidence,s.confidence);
      if(Number.isFinite(last.boundaryConfidence)&&Number.isFinite(s.boundaryConfidence))last.boundaryConfidence=Math.min(last.boundaryConfidence,s.boundaryConfidence);
    } else out.push({...s});
  }return out;
}
// 本地召回不调用模型。强线索可单独触发；弱线索需在相邻字幕出现不同类别。
const STRONG_CUES = /(?:本期|本次|本视频|这期).{0,18}(?:赞助|赞助商|合作伙伴|独家支持)|感谢.{0,24}(?:赞助|冠名|商务支持)|(?:赞助|冠名).{0,12}(?:本期|本视频)|感谢.{0,45}支持|支持我们(?:来到|到|拍摄)|支持本期|去官网|(?:app|APP|网站).{0,15}(?:搜|同款|定制)|广告时间|恰饭时间|商务合作|推广链接|专属(?:优惠|礼包|兑换|口令)|优惠码|兑换码|礼包码|下载链接|点击.{0,12}(?:链接|下载|领取)|评论区.{0,16}(?:置顶|链接|下载)|简介.{0,12}(?:链接|下载)|一键三连.{0,10}之前|sponsored by|paid partnership|promo code|use.{0,10}my code/i;
const WEAK_CUES = [/下载|安装|注册|预约|入坑/,/福利|礼包|折扣|优惠|首充|返利|免费领取/,/链接|评论区|置顶|简介|二维码|搜索/,/金主|赞助|合作|推荐给大家|安利|支持一下/];
export function candidateWindows(rows,brandHints=DEFAULTS.brandHints) {
  const brands=String(brandHints||'').split(/[,，\n]/).map(x=>x.trim()).filter(Boolean).slice(0,30);
  const hits=[];
  for(let i=0;i<rows.length;i++) {
    // 拼接相邻短句，避免“感谢 XX / 对本期视频的赞助”被断句漏掉。
    const nearby=rows.slice(i,Math.min(i+8,rows.length)).filter(r=>r.from-rows[i].from<=30);
    const text=nearby.map(r=>r.content).join('');
    const product=/(?:这款|这台|这辆|这双|这个车|它有|它可以|它的|使用后|用完|长期使用)/.test(text);
    const benefits=[/解决|搞定|修护|预防/,/清爽|舒适|稳定|稳当|丝滑/,/体验|模式|底盘|护理|屏障|搭载/].filter(re=>re.test(text)).length;
    if(brands.some(brand=>text.includes(brand))||STRONG_CUES.test(text)||WEAK_CUES.filter(re=>re.test(text)).length>=2||(product&&benefits>=2))hits.push({start:Math.max(0,rows[i].from-60),end:nearby.at(-1).to+120});
  }
  const windows=[];
  for(const hit of hits){const last=windows.at(-1);if(last&&hit.start<=last.end)last.end=Math.max(last.end,hit.end);else windows.push({...hit});}
  return windows.map(w=>rows.filter(r=>r.to>w.start&&r.from<w.end));
}
// 字符预算约束输入体积，避免单条超长字幕突破仅按条数切块的限制。
export function budgetChunks(rows,maxChars=6000,maxRows=240,overlap=12) {
  const out=[];let start=0;
  while(start<rows.length){let end=start,chars=0;while(end<rows.length&&end-start<maxRows){const n=JSON.stringify([rows[end].id,rows[end].content]).length+1;if(end>start&&chars+n>maxChars)break;chars+=n;end++;}out.push(rows.slice(start,end));if(end>=rows.length)break;start=Math.max(start+1,end-overlap);}
  return out;
}
export function compactRows(rows){return rows.map(r=>[r.id,r.content]);}
export function planAnalysis(rows,economy=true,duration=rows.at(-1)?.to||0,brandHints=DEFAULTS.brandHints) {
  // 短视频直接确认全文，避免为省少量输入漏掉占比很高的广告。
  const short=duration<=480;
  const windows=economy&&!short?candidateWindows(rows,brandHints):[rows];
  const parts=windows.flatMap(w=>budgetChunks(w));
  const fullChars=JSON.stringify(compactRows(rows)).length;
  const sentChars=parts.reduce((sum,p)=>sum+JSON.stringify(compactRows(p)).length,0);
  return {parts,stats:{mode:economy&&!short?'candidates':short?'short-full':'full',totalRows:rows.length,selectedRows:new Set(parts.flat().map(r=>r.id)).size,windows:windows.length,requests:parts.length,fullChars,sentChars}};
}
export function touchesBoundary(segment,part,all) {
  return !!segment.truncated || (part[0].id>all[0].id&&segment.start<=part[Math.min(1,part.length-1)].from) || (part.at(-1).id<all.at(-1).id&&segment.end>=part[Math.max(0,part.length-2)].to);
}

export function sponsorContext(rows) {
  const selected=new Map();
  for(let i=0;i<rows.length;i++) {
    const nearby=rows.slice(i,i+5).filter(r=>r.from-rows[i].from<20).map(r=>r.content).join('');
    if(/感谢.{0,45}(?:赞助|支持)|支持我们(?:来到|到|拍摄)|支持本期|本期.{0,20}(?:赞助|冠名)/.test(nearby)) {
      for(const r of rows.slice(Math.max(0,i-1),i+5))selected.set(r.id,r.content);
    }
  }
  return [...selected.values()].join(' ').slice(0,700);
}

export function normalizeSettings(saved={}) {
  saved=saved||{};
  const settings=Object.fromEntries(Object.entries(DEFAULTS).map(([key,value])=>[key,saved[key]??value]));
  settings.provider='jev';return settings;
}
