const $=id=>document.getElementById(id);
const send=async msg=>{const r=await chrome.runtime.sendMessage(msg);if(!r?.ok)throw Error(r?.error||'暂时无法检查更新');return r.result;};
$('installedVersion').textContent=chrome.runtime.getManifest().version;
$('upgradeLink').href=chrome.runtime.getURL('upgrade.html');
function render(s){
 $('autoUpdateChecks').checked=s.enabled;
 $('upgradeLink').textContent=s.available?`前往升级 · ${s.release.version}`:'打开升级页面';
 $('updateStatus').textContent=s.error?`${s.error}${s.available?'；上次发现新版 '+s.release.version:''}`:s.available?`发现新版 ${s.release.version}`:s.checkedAt?'暂无更新':'尚未检查更新';
 $('updateStatus').classList.toggle('error',!!s.error);
}
async function check(force=false){$('checkUpdate').disabled=true;try{render(await send({type:'checkUpdate',force}));}catch(e){$('updateStatus').textContent=e.message;}finally{$('checkUpdate').disabled=false;}}
$('checkUpdate').onclick=()=>check(true);
$('autoUpdateChecks').onchange=async()=>{try{render(await send({type:'updateChecks',enabled:$('autoUpdateChecks').checked}));}catch(e){$('updateStatus').textContent=e.message;}};
try{const s=await send({type:'updateStatus'});render(s);if(s.enabled)await check();}catch(e){$('updateStatus').textContent=e.message;}
