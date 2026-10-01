import {RELEASES,compareVersions} from './updates.js';
import {fetchPackage} from './update-package.js';
import {updateState,verifyDirectory,installFiles,restoreFiles} from './update-install.js';
const $=id=>document.getElementById(id),current=chrome.runtime.getManifest();
let latest,prepared,root,working=false;
const canInstall=typeof globalThis.showDirectoryPicker==='function';
const send=async msg=>{const r=await chrome.runtime.sendMessage(msg);if(!r?.ok)throw Error(r?.error||'插件连接失败，请重新加载');return r.result;};
function message(text,error=false){$('updateStatus').textContent=text;$('updateStatus').classList.toggle('error',error);}
function busy(value){working=value;for(const b of $('updates').querySelectorAll('button'))b.disabled=value;$('applyUpdate').disabled=value||!prepared||!root||!canInstall;$('bindUpdateDirectory').disabled=value||!canInstall;$('prepareUpdate').disabled=value||!canInstall;}
function render(s){
 latest=s.release;$('autoUpdateChecks').checked=s.enabled;
 $('installedVersion').textContent=current.version;
 $('releaseLink').href=latest?.page||RELEASES+'/latest';
 $('downloadUpdate').hidden=!s.available;$('prepareUpdate').hidden=!s.available;
 $('downloadUpdate').href=latest?.assets?.['bilibili-ad-skipper.zip']?.url||RELEASES+'/latest';
 $('updateNotes').textContent=s.available?latest.notes:'';$('updateDetails').hidden=!s.available;
 const when=s.checkedAt?new Date(s.checkedAt).toLocaleString():'';
 message(s.error?`${s.error}。${s.available?`上次发现新版 ${latest.version}，可稍后重试或下载升级。`:'可通过发布页查看。'}`:s.available?`发现新版 ${latest.version}${when?' · 检查于 '+when:''}`:s.checkedAt?`${latest&&compareVersions(current.version,latest.version)>0?'当前版本高于最新发布版 '+latest.version:'当前已是最新正式版'}${when?' · 检查于 '+when:''}`:'尚未检查更新',!!s.error);
}
async function check(force){busy(true);message('正在检查 GitHub 正式版本…');try{prepared=null;render(await send({type:'checkUpdate',force}));}catch(e){message(e.message,true);}finally{busy(false);}}
$('checkUpdate').onclick=()=>check(true);
$('autoUpdateChecks').onchange=async()=>{try{await send({type:'updateChecks',enabled:$('autoUpdateChecks').checked});message($('autoUpdateChecks').checked?'已开启每天检查更新；安装仍需你点击。':'已关闭自动检查，仍可手动检查。');}catch(e){message(e.message,true);}};
$('bindUpdateDirectory').onclick=async()=>{
 try{
  // Call the picker directly from the user's click, before unrelated async work.
  const picked=await showDirectoryPicker({id:'bili-extension-install',mode:'readwrite'});busy(true);
  await verifyDirectory(picked,{runtime:chrome.runtime});await updateState('directory',picked);root=picked;
  $('updateDirectory').textContent=`已绑定原安装文件夹：${root.name}`;message('原安装文件夹已确认，以后升级仍需点击，浏览器可能再次请求写入许可。');
 }catch(e){message(e.name==='AbortError'?'已取消选择，未更新插件。':e.message,true);}finally{busy(false);}
};
$('prepareUpdate').onclick=async()=>{
 busy(true);message('正在下载安装包并校验，请稍候…');
 try{prepared=await fetchPackage(latest,current);$('installControls').open=true;message(`新版 ${latest.version} 已下载并通过校验。${root?'点击“安装并重新加载”完成升级。':'请先选择原安装文件夹。'}`);}
 catch(e){prepared=null;message(e.message,true);}finally{busy(false);}
};
async function writable(){if(!root)throw Error('请先选择原安装文件夹');if(await root.requestPermission({mode:'readwrite'})!=='granted')throw Error('未获得文件夹写入许可，未更新插件');}
async function locked(task){await navigator.locks.request('bili-extension-update',{ifAvailable:true},async lock=>{if(!lock)throw Error('另一个设置页面正在更新，请等待完成');await task();});}
$('applyUpdate').onclick=async()=>{
 try{
  if($('status').textContent==='设置尚未保存')throw Error('请先保存设置，再升级插件');
  await writable();if(!prepared)throw Error('请先下载安装包并校验');busy(true);
  await locked(async()=>{await installFiles({root,files:prepared,current,runtime:chrome.runtime,onProgress:message});});
  await chrome.storage.local.set({'extensionUpdate:lastInstall':{from:current.version,to:latest.version,at:Date.now()}});
  message('文件已更新并校验，正在重新加载插件。完成后请刷新已打开的 B站视频页。');
  working=false;chrome.runtime.reload();
 }catch(e){message(e.message,true);$('restoreUpdateBackup').hidden=!(await updateState('backup').catch(()=>null));}finally{busy(false);}
};
$('restoreUpdateBackup').onclick=async()=>{
 try{await writable();busy(true);await locked(async()=>{await verifyDirectory(root,{runtime:chrome.runtime});const record=await updateState('backup');await restoreFiles(root,record);await updateState('backup',{...record,phase:'restored'});});message('已恢复备份，正在重新加载…');working=false;chrome.runtime.reload();}
 catch(e){message(e.message,true);}finally{busy(false);}
};
window.addEventListener('beforeunload',event=>{if(working&&prepared){event.preventDefault();event.returnValue='';}});
$('installedVersion').textContent=current.version;
try{root=await updateState('directory');$('updateDirectory').textContent=root?`已绑定原安装文件夹：${root.name}`:'尚未选择原安装文件夹';$('restoreUpdateBackup').hidden=!(await updateState('backup'));}catch{message('无法保存升级文件夹，可使用下载升级。',true);}
if(!globalThis.showDirectoryPicker){$('bindUpdateDirectory').disabled=true;$('prepareUpdate').disabled=true;$('updateDirectory').textContent='此浏览器不支持文件夹授权，请使用下载升级。';}
try{const state=await send({type:'updateStatus'});render(state);if(state.enabled)await check(false);}catch(e){message(e.message,true);}
busy(false);

const lastInstall=(await chrome.storage.local.get('extensionUpdate:lastInstall'))['extensionUpdate:lastInstall'];
if(lastInstall?.to===current.version&&Date.now()-lastInstall.at<300000)message(`已升级至 ${current.version}，原设置已保留。请刷新已打开的 B站视频页。`);
