import {sha256} from './update-package.js';
const DB='extension-updater-v1';
async function db(){return new Promise((resolve,reject)=>{const r=indexedDB.open(DB,1);r.onupgradeneeded=()=>r.result.createObjectStore('state');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
export async function updateState(key,value){
 const database=await db();try{return await new Promise((resolve,reject)=>{const tx=database.transaction('state',arguments.length>1?'readwrite':'readonly'),s=tx.objectStore('state'),r=arguments.length>1?s.put(value,key):s.get(key);let result;r.onsuccess=()=>result=r.result;tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||Error('更新状态保存失败'));});}finally{database.close();}
}
async function entry(root,path,create=false){const bits=path.split('/');let dir=root;for(const part of bits.slice(0,-1))dir=await dir.getDirectoryHandle(part,{create});return dir.getFileHandle(bits.at(-1),{create});}
async function read(root,path){try{return new Uint8Array(await(await(await entry(root,path)).getFile()).arrayBuffer());}catch(e){if(e.name==='NotFoundError')return null;throw e;}}
async function write(root,path,bytes){const h=await entry(root,path,true),w=await h.createWritable();try{await w.write(bytes);await w.close();}catch(e){await w.abort().catch(()=>{});throw e;}}
async function remove(root,path){const bits=path.split('/');let dir=root;for(const part of bits.slice(0,-1))dir=await dir.getDirectoryHandle(part);await dir.removeEntry(bits.at(-1));}
export async function verifyDirectory(root,{runtime,fetch=globalThis.fetch}){
 const raw=await read(root,'manifest.json');let manifest;try{manifest=JSON.parse(new TextDecoder().decode(raw));}catch{throw Error('请选择包含 manifest.json 的原安装文件夹');}
 if(manifest.name!==runtime.getManifest().name)throw Error('所选文件夹不是 B站广告跳过');
 // Prove this is the directory actually served by this extension, not another copy.
 const nonce=crypto.randomUUID(),path='bili-update-probe-'+nonce+'.json';
 try{
  await write(root,path,new TextEncoder().encode(JSON.stringify({nonce})));
  const response=await fetch(runtime.getURL(path),{cache:'no-store'});
  if(!response.ok||(await response.json()).nonce!==nonce)throw Error('wrong directory');
 }catch{throw Error('无法确认这是当前插件的原安装文件夹，请在扩展管理页核对安装路径');}
 finally{await root.removeEntry(path).catch(()=>{});}
 return manifest;
}
export async function installFiles({root,files,current,runtime,fetch=globalThis.fetch,save=updateState,onProgress=()=>{}}){
 const existing=await verifyDirectory(root,{runtime,fetch});
 if(existing.version!==current.version)throw Error('安装目录版本已变化，请重新加载插件后再试');
 // Save every overwritten byte before the first source change. Unrelated files stay intact.
 const backup=[];for(const path of files.keys())backup.push({path,bytes:await read(root,path)});
 const record={from:current.version,to:JSON.parse(new TextDecoder().decode(files.get('manifest.json'))).version,at:Date.now(),phase:'writing',backup};
 await save('backup',record);
 const paths=[...files.keys()].filter(p=>p!=='manifest.json').concat('manifest.json');
 try{
  for(let i=0;i<paths.length;i++){const path=paths[i];onProgress(`正在更新文件 ${i+1}/${paths.length}…`);await write(root,path,files.get(path));if(await sha256(await read(root,path))!==await sha256(files.get(path)))throw Error('更新文件读回校验失败');}
  record.phase='installed';await save('backup',record);
 }catch(error){
  try{await restoreFiles(root,record);record.phase='restored';await save('backup',record);}catch{throw Error('更新中断且未能完整回退。请保持此页面，点击“恢复上次备份”；也可下载原版覆盖目录后重新加载。');}
  throw Error('更新失败，已恢复原文件。请重试或使用下载升级。');
 }
 return record;
}
export async function restoreFiles(root,record){
 if(!record?.backup?.length)throw Error('没有可恢复的备份');
 for(const item of [...record.backup.filter(x=>x.path!=='manifest.json'),...record.backup.filter(x=>x.path==='manifest.json')]){
  if(item.bytes===null){try{await remove(root,item.path);}catch(e){if(e.name!=='NotFoundError')throw e;}}
  else{await write(root,item.path,item.bytes);if(await sha256(await read(root,item.path))!==await sha256(item.bytes))throw Error('恢复文件校验失败');}
 }
}
