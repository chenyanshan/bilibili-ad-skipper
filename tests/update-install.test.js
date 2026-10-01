import test from 'node:test';import assert from 'node:assert/strict';
import {verifyDirectory,installFiles,restoreFiles} from '../extension/update-install.js';
const encode=s=>new TextEncoder().encode(s),decode=b=>new TextDecoder().decode(b);
function fixture(){
 const current={name:'B站广告跳过',version:'0.6.2'},disk=new Map([['manifest.json',encode(JSON.stringify(current))],['a.js',encode('old')],['notes.txt',encode('keep')]]),writes=[];let fail=null;
 const missing=()=>Object.assign(Error('missing'),{name:'NotFoundError'});
 function directory(prefix=''){return {name:'extension',getDirectoryHandle:async name=>directory(prefix+name+'/'),getFileHandle:async(name,{create=false}={})=>{
 const path=prefix+name;if(!disk.has(path)&&!create)throw missing();return {getFile:async()=>{if(!disk.has(path))throw missing();return new Blob([disk.get(path)]);},createWritable:async()=>{let value;return {write:async b=>{value=new Uint8Array(b);},abort:async()=>{},close:async()=>{if(path===fail){fail=null;throw Error('disk full');}disk.set(path,value);writes.push(path);}};}};
 },removeEntry:async name=>{if(!disk.delete(prefix+name))throw missing();}};}
 const root=directory(),runtime={getManifest:()=>current,getURL:p=>'chrome-extension://fixture/'+p},fetch=async url=>{const bytes=disk.get(url.split('/').at(-1));return new Response(bytes||'',{status:bytes?200:404});},records={};
 return {current,disk,writes,root,runtime,fetch,records,save:async(k,v)=>records[k]=structuredClone(v),failOn:p=>fail=p};
}
function files(){return new Map([['a.js',encode('new')],['icons/new.png',encode('image')],['manifest.json',encode(JSON.stringify({name:'B站广告跳过',version:'0.7.0'}))]]);}
test('directory identity probe is cleaned; identical copied directory cannot pass',async()=>{
 const f=fixture();assert.equal((await verifyDirectory(f.root,f)).version,'0.6.2');assert.ok(![...f.disk.keys()].some(k=>k.startsWith('bili-update-probe')));
 await assert.rejects(verifyDirectory(f.root,{...f,fetch:async()=>new Response('',{status:404})}),/原安装/);assert.equal(f.disk.size,3);
});
test('upgrade backs up originals before writes, changes manifest last, preserves unrelated files',async()=>{
 const f=fixture();let snapshotAt;const record=await installFiles({...f,files:files(),save:async(k,v)=>{if(v.phase==='writing')snapshotAt=decode(f.disk.get('a.js'));await f.save(k,v);}});
 assert.equal(snapshotAt,'old');assert.equal(record.phase,'installed');assert.equal(f.writes.at(-1),'manifest.json');assert.equal(decode(f.disk.get('a.js')),'new');assert.equal(decode(f.disk.get('notes.txt')),'keep');assert.equal(f.records.backup.backup.find(x=>x.path==='icons/new.png').bytes,null);
 await restoreFiles(f.root,record);assert.equal(decode(f.disk.get('a.js')),'old');assert.equal(f.disk.has('icons/new.png'),false);assert.equal(JSON.parse(decode(f.disk.get('manifest.json'))).version,'0.6.2');
});
test('write failure restores overwritten files, removes new files, and keeps settings outside disk untouched',async()=>{
 const f=fixture();f.failOn('manifest.json');await assert.rejects(installFiles({...f,files:files()}),/已恢复/);assert.equal(decode(f.disk.get('a.js')),'old');assert.equal(f.disk.has('icons/new.png'),false);assert.equal(f.records.backup.phase,'restored');
});
test('backup failure or stale loaded manifest prevents source mutations',async()=>{
 const f=fixture();await assert.rejects(installFiles({...f,files:files(),save:async()=>{throw Error('storage full');}}),/storage full/);assert.equal(decode(f.disk.get('a.js')),'old');
 f.disk.set('manifest.json',encode(JSON.stringify({...f.current,version:'0.7.0'})));await assert.rejects(installFiles({...f,files:files()}),/版本已变化/);assert.equal(decode(f.disk.get('a.js')),'old');
});
