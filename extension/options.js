import {DEFAULTS} from './core.js';
import {providerConfig,connectionProbe,validateProbe} from './providers.js';
const $=id=>document.getElementById(id),status=$('status');
$('version').textContent=chrome.runtime.getManifest().version;
const saved={...DEFAULTS,...(await chrome.storage.local.get('settings')).settings};
for(const [key,value]of Object.entries(saved)){if(!$(key))continue;if(typeof value==='boolean')$(key).checked=value;else $(key).value=value;}
function showProvider(){
  for(const id of ['llm','jev']){const active=$('provider').value===id;$(id+'Fields').hidden=!active;$(id+'Fields').disabled=!active;}
}
showProvider();$('provider').onchange=()=>{showProvider();status.textContent='点击保存后切换识别方式；另一种方式的配置会保留。';};
$('form').addEventListener('submit',async e=>{
  e.preventDefault();try{
    const s={...DEFAULTS};for(const key of Object.keys(s))s[key]=typeof s[key]==='boolean'?$(key).checked:$(key).value.trim();
    for(const key of ['threshold','jevThreshold','minDuration'])s[key]=Number(s[key]);
    if(!Number.isFinite(s.minDuration)||s.minDuration<0||s.minDuration>240)throw Error('最短广告时长必须在 0 到 240 秒之间');
    const p=providerConfig(s);if(!p.model)throw Error(`请输入 ${p.name} 模型名称`);
    const min=p.id==='jev'?.5:.8;if(!Number.isFinite(p.threshold)||p.threshold<min||p.threshold>1)throw Error(`判断门槛必须在 ${min} 到 1 之间`);
    if(!p.key)throw Error(`请填写 ${p.name} API Key`);
    const allowed=await chrome.permissions.request({origins:[new URL(p.url).origin+'/*']});if(!allowed)throw Error('未获得接口访问权限，设置未保存');
    await chrome.storage.local.set({settings:s});status.textContent=`已保存，当前使用 ${p.name}。视频页会自动应用新配置。`;
  }catch(e){status.textContent=e.message;}
});
$('clear').onclick=async()=>{const all=await chrome.storage.local.get(null);await chrome.storage.local.remove(Object.keys(all).filter(k=>k.startsWith('cache:')));status.textContent='已清除缓存';};
$('test').onclick=async()=>{
  $('test').disabled=true;status.textContent='测试已保存的配置…';
  try{
    const s={...DEFAULTS,...(await chrome.storage.local.get('settings')).settings},p=providerConfig(s);
    if(!p.key)throw Error(`请先保存 ${p.name} API Key`);
    const r=await fetch(p.url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(25000),headers:{'Content-Type':'application/json',Authorization:`Bearer ${p.key}`},body:JSON.stringify(connectionProbe(s))});
    if(!r.ok)throw Error(`HTTP ${r.status}`);validateProbe(p.id,await r.json());status.textContent=`${p.name} 连接成功`;
  }catch(e){status.textContent=`连接失败：${e.message}`;}finally{$('test').disabled=false;}
};
