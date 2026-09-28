import {DEFAULTS} from './core.js';
import {providerConfig,connectionProbe,validateProbe} from './providers.js';
const $=id=>document.getElementById(id),status=$('status');
$('version').textContent=chrome.runtime.getManifest().version;
let saved={...DEFAULTS,...(await chrome.storage.local.get('settings')).settings};
for(const [key,value]of Object.entries(saved)){if(!$(key))continue;if(typeof value==='boolean')$(key).checked=value;else $(key).value=value;}
function showProvider(){
  for(const id of ['llm','jev']){const active=$('provider').value===id;$(id+'Fields').hidden=!active;$(id+'Fields').disabled=!active;}
  $('communityAutoSubmit').disabled=$('provider').value!=='jev';
}
function message(text,error=false){status.textContent=text;status.classList.toggle('error',error);}
function busy(value){for(const el of $('form').elements)el.disabled=value;if(!value)showProvider();}
showProvider();$('provider').onchange=()=>{showProvider();message('点击保存后切换识别方式；另一种方式的配置会保留。');};
$('form').addEventListener('input',()=>message('设置尚未保存'));
$('form').addEventListener('submit',async e=>{
  e.preventDefault();try{
    const s={...saved};for(const key of Object.keys(DEFAULTS)){if(!$(key))continue;s[key]=typeof DEFAULTS[key]==='boolean'?$(key).checked:$(key).value.trim();}
    for(const key of ['threshold','jevThreshold','minDuration'])s[key]=Number(s[key]);
    if(!Number.isFinite(s.minDuration)||s.minDuration<0||s.minDuration>240)throw Error('最短广告时长必须在 0 到 240 秒之间');
    const hasKey=Boolean(s.provider==='jev'?s.jevApiKey:s.apiKey),origins=[];
    if(s.communityEnabled)origins.push('https://www.bsbsb.top/*');
    if(hasKey){
      const p=providerConfig(s);if(!p.model)throw Error(`请输入 ${p.name} 模型名称`);
      const min=p.id==='jev'?.5:.8;if(!Number.isFinite(p.threshold)||p.threshold<min||p.threshold>1)throw Error(`判断门槛必须在 ${min} 到 1 之间`);
      const url=new URL(p.url);origins.push(`${url.protocol}//${url.hostname}/*`);
    }
    // Request from this save gesture; no startup requests or provider fallback.
    const permission=origins.length?chrome.permissions.request({origins}):Promise.resolve(true);
    busy(true);message('正在保存设置…');
    if(!await permission)throw Error('未获得服务访问权限，设置未保存；请重试并允许访问');
    await chrome.storage.local.set({settings:s});saved=s;
    message(hasKey?`已保存：${s.communityEnabled?'社区广告优先，没有再用 ':''}${s.provider==='jev'?'JEV':'LLM'}。`:`已保存：${s.communityEnabled?'仅使用社区广告，无需 API Key。':'未配置 AI Key；可保留设置，稍后填写。'}`);
  }catch(e){message(e.message,true);}finally{busy(false);}
});
$('clear').onclick=async()=>{try{const all=await chrome.storage.local.get(null);await chrome.storage.local.remove(Object.keys(all).filter(k=>k.startsWith('cache:')||k.startsWith('analysisCache:')||k==='community:cache'));message('已清除分析缓存；投稿去重记录保留');}catch(e){message(e.message,true);}};
$('test').onclick=async()=>{
  $('test').disabled=true;message('测试已保存的 AI 配置…');
  try{
    const s={...DEFAULTS,...(await chrome.storage.local.get('settings')).settings};
    if(!(s.provider==='jev'?s.jevApiKey:s.apiKey))throw Error('尚未配置 AI Key；社区广告无需测试 AI 连接');
    const p=providerConfig(s);
    const r=await fetch(p.url,{method:'POST',redirect:'error',credentials:'omit',signal:AbortSignal.timeout(25000),headers:{'Content-Type':'application/json',Authorization:`Bearer ${p.key}`},body:JSON.stringify(connectionProbe(s))});
    if(!r.ok)throw Error(`HTTP ${r.status}`);validateProbe(p.id,await r.json());message(`${p.name} 连接成功`);
  }catch(e){message(`连接测试：${e.message}`,true);}finally{$('test').disabled=false;}
};
