import {RELEASES,compareVersions} from './updates.js';
import {fetchPackage} from './update-package.js';
import {updateState,verifyDirectory,installFiles,restoreFiles} from './update-install.js';
const $=id=>document.getElementById(id),current=chrome.runtime.getManifest();
let latest,root,working=false,available=false,writing=false;
const canInstall=typeof globalThis.showDirectoryPicker==='function';
const send=async msg=>{const r=await chrome.runtime.sendMessage(msg);if(!r?.ok)throw Error(r?.error||'插件连接失败，请重新加载');return r.result;};
function message(text,error=false){$('updateStatus').textContent=text;$('updateStatus').classList.toggle('error',error);}
function actions(){
 const inplace=!!root&&canInstall;
 $('upgradeAction').hidden=!available;$('upgradeAction').textContent=inplace?'立即升级':'前往下载新版';
 $('upgradeHelp').textContent=inplace?'点击后自动下载、校验和安装，再重新加载插件；已有设置保留。':'前往发布页下载新版，按下方步骤更新，已有设置会保留。';
 $('updateDirectory').textContent=root?'已记住授权，后续升级无需重新寻找文件夹。':'尚未启用；不影响下载升级。';
 $('bindUpdateDirectory').textContent=root?'重新授权':'授权原地升级';
 for(const b of $('updates').querySelectorAll('button'))b.disabled=working;
 $('bindUpdateDirectory').disabled=working||!canInstall;
}
function busy(value){working=value;actions();}
function render(s){
 latest=s.release;available=s.available;$('releaseLink').href=latest?.page||RELEASES+'/latest';
 $('updateNotes').textContent=available?latest.notes:'';$('updateDetails').hidden=!available;
 message(s.error?`${s.error}。${available?'上次发现新版 '+latest.version+'；可通过发布页下载。':'可通过发布页查看。'}`:available?`发现新版 ${latest.version}`:s.checkedAt?latest&&compareVersions(current.version,latest.version)>0?'当前版本高于最新发布版 '+latest.version:'当前已是最新正式版':'尚未检查更新',!!s.error);actions();
}
async function check(force=false){busy(true);message('正在检查新版本…');try{render(await send({type:'checkUpdate',force}));}catch(e){message(e.message,true);}finally{busy(false);}}
$('checkUpdate').onclick=()=>check(true);
$('openExtensionManager').onclick=async()=>{try{await send({type:'openExtensionManager'});}catch{message('请将下方插件管理地址复制到浏览器地址栏。',true);}};
$('managerAddress').textContent='chrome://extensions/?id='+chrome.runtime.id;
$('bindUpdateDirectory').onclick=async()=>{
 try{
  const picked=await showDirectoryPicker({id:'bili-extension-install',mode:'readwrite'});busy(true);
  await verifyDirectory(picked,{runtime:chrome.runtime});await updateState('directory',picked);root=picked;
  $('installControls').open=false;message('原地升级已启用。发现新版后，点击“立即升级”即可。');
 }catch(e){if(e.name!=='AbortError')$('downloadHelp').open=true;message(e.name==='AbortError'?'已取消授权，仍可前往下载新版。':e.message,true);}finally{busy(false);}
};
async function writable(){if(!root)throw Error('请先授权原地升级');if(await root.requestPermission({mode:'readwrite'})!=='granted')throw Error('未获得写入许可，未更新插件。可通过发布页下载。');}
async function locked(task){await navigator.locks.request('bili-extension-update',{ifAvailable:true},async lock=>{if(!lock)throw Error('另一个升级页面正在更新，请等待完成');await task();});}
$('upgradeAction').onclick=async()=>{
 if(!available||working)return;
 if(!root||!canInstall){window.open(latest.page,'_blank','noopener,noreferrer');$('downloadHelp').open=true;return;}
 try{
  // Request existing folder permission from the click, before network requests.
  const permission=writable();busy(true);await permission;
  message('正在下载并校验新版…');const files=await fetchPackage(latest,current);
  writing=true;await locked(()=>installFiles({root,files,current,runtime:chrome.runtime,onProgress:text=>message(text)}));
  await chrome.storage.local.set({'extensionUpdate:lastInstall':{from:current.version,to:latest.version,at:Date.now()}});
  message('升级完成，正在重新加载。请刷新已打开的 B站视频页。');writing=false;working=false;chrome.runtime.reload();
 }catch(e){message(e.message,true);$('downloadHelp').open=true;$('restoreUpdateBackup').hidden=!(await updateState('backup').catch(()=>null));}finally{writing=false;busy(false);}
};
$('restoreUpdateBackup').onclick=async()=>{
 try{const permission=writable();busy(true);await permission;writing=true;await locked(async()=>{await verifyDirectory(root,{runtime:chrome.runtime});const record=await updateState('backup');await restoreFiles(root,record);await updateState('backup',{...record,phase:'restored'});});message('已恢复备份，正在重新加载…');writing=false;working=false;chrome.runtime.reload();}
 catch(e){message(e.message,true);}finally{writing=false;busy(false);}
};
window.addEventListener('beforeunload',event=>{if(writing){event.preventDefault();event.returnValue='';}});
$('installedVersion').textContent=current.version;
try{root=await updateState('directory');$('restoreUpdateBackup').hidden=!(await updateState('backup'));}catch{message('无法读取原地升级授权，可通过发布页下载。',true);}
try{const s=await send({type:'updateStatus'});render(s);if(s.enabled)await check();}catch(e){message(e.message,true);}finally{busy(false);}
const last=(await chrome.storage.local.get('extensionUpdate:lastInstall'))['extensionUpdate:lastInstall'];
if(last?.to===current.version&&Date.now()-last.at<300000)message(`已升级至 ${current.version}，原设置已保留。请刷新已打开的 B站视频页。`);
