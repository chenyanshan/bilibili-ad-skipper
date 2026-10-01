import {DEFAULTS,normalizeSettings} from './core.js';
import {providerConfig} from './providers.js';
const $=id=>document.getElementById(id),status=$('status');
$('version').textContent=chrome.runtime.getManifest().version;
let saved=normalizeSettings((await chrome.storage.local.get('settings')).settings);
for(const [key,value]of Object.entries(saved)){if(!$(key))continue;if(typeof value==='boolean')$(key).checked=value;else $(key).value=value;}
function message(text,error=false){status.textContent=text;status.classList.toggle('error',error);}
function busy(value){for(const el of $('form').elements)el.disabled=value;}
$('form').addEventListener('input',()=>message('设置尚未保存'));
$('form').addEventListener('submit',async e=>{
  e.preventDefault();try{
    const s={...saved};for(const key of Object.keys(DEFAULTS)){if(!$(key))continue;s[key]=typeof DEFAULTS[key]==='boolean'?$(key).checked:$(key).value.trim();}
    for(const key of ['jevThreshold','minDuration'])s[key]=Number(s[key]);
    if(!Number.isFinite(s.minDuration)||s.minDuration<0||s.minDuration>240)throw Error('最短广告时长必须在 0 到 240 秒之间');
    const hasKey=Boolean(s.jevApiKey),origins=[];
    if(s.communityEnabled)origins.push('https://www.bsbsb.top/*');
    if(hasKey){
      const p=providerConfig(s);if(!p.model)throw Error(`请输入 ${p.name} 模型名称`);
      const min=.5;if(!Number.isFinite(p.threshold)||p.threshold<min||p.threshold>1)throw Error(`判断门槛必须在 ${min} 到 1 之间`);
      const url=new URL(p.url);origins.push(`${url.protocol}//${url.hostname}/*`);
    }
    // Request from this save gesture; no startup requests or provider fallback.
    const permission=origins.length?chrome.permissions.request({origins}):Promise.resolve(true);
    busy(true);message('正在保存设置…');
    if(!await permission)throw Error('未获得服务访问权限，设置未保存；请重试并允许访问');
    await chrome.storage.local.set({settings:s});saved=s;void refreshUsage();
    message(hasKey?`已保存：${s.communityEnabled?'社区广告优先，没有再用 ':''}JEV。`:`已保存：${s.communityEnabled?'仅使用社区广告，无需 API Key。':'未配置 AI Key；可保留设置，稍后填写。'}`);
  }catch(e){message(e.message,true);}finally{busy(false);}
});
$('clear').onclick=async()=>{try{const all=await chrome.storage.local.get(null);await chrome.storage.local.remove(Object.keys(all).filter(k=>k.startsWith('cache:')||k.startsWith('analysisCache:')||k==='community:cache'));message('已清除分析缓存；投稿去重记录保留');}catch(e){message(e.message,true);}};
$('test').onclick=async()=>{
  $('test').disabled=true;message('测试已保存的 AI 配置…');
  try{
    const r=await chrome.runtime.sendMessage({type:'testConnection'});if(!r.ok)throw Error(r.error);message('JEV 连接成功');
  }catch(e){message(`连接测试：${e.message}`,true);}finally{$('test').disabled=false;void refreshUsage();}
};

async function refreshUsage(){
  $('refreshUsage').disabled=true;$('usage').textContent='正在读取本机用量…';
  try{
    const r=await chrome.runtime.sendMessage({type:'usage'});if(!r.ok)throw Error(r.error);
    const u=r.result;
    $('usageTable').hidden=!saved.jevApiKey;
    $('usage').textContent=!saved.jevApiKey?'保存 JEV Key 后开始记录本机用量。':u.recent.requests?`已记录 ${u.days} 个使用日；${u.recent.unknown} 次请求缺少完整用量，${u.recent.unpriced} 次未计入费用估算。`:'尚无请求记录；识别视频或测试连接后会显示用量。';
    for(const period of ['today','recent']){
      const data=u[period];
      for(const metric of ['Requests','Input','Output'])$(period+metric).textContent=data[metric.toLowerCase()].toLocaleString();
      $(period+'Cost').textContent=data.unpriced===data.requests&&data.requests>0?'暂无估价':`${data.unpriced?'已知部分 ':''}$${data.cost.toFixed(6)}`;
    }
  }catch{$('usageTable').hidden=true;$('usage').textContent='读取本机用量失败，请稍后刷新。';}finally{$('refreshUsage').disabled=false;}
}
$('refreshUsage').onclick=refreshUsage;
await refreshUsage();
