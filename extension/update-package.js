import {compareVersions} from './updates.js';
const MAX=8*1024*1024,MAX_FILES=128,decoder=new TextDecoder('utf-8',{fatal:true});
export async function sha256(bytes){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');}
function safePath(name){return typeof name==='string'&&name.length<160&&/^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.(?:js|json|html|css|png|svg)$/.test(name);}
function crc32(bytes){let crc=0xffffffff;for(const b of bytes){crc^=b;for(let k=0;k<8;k++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
async function inflate(data,limit){
 const reader=new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader(),chunks=[];let size=0;
 try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>limit)throw Error('安装包解压大小超出限制');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
 const out=new Uint8Array(size);let offset=0;for(const chunk of chunks){out.set(chunk,offset);offset+=chunk.length;}return out;
}
// Only the regular, bounded ZIPs produced by scripts/package.py are supported.
export async function unpackExtension(bytes){
 const data=new Uint8Array(bytes),v=new DataView(data.buffer,data.byteOffset,data.byteLength);
 if(data.length<22||data.length>MAX)throw Error('安装包大小异常');
 let eocd=-1;for(let p=data.length-22;p>=Math.max(0,data.length-65557);p--)if(v.getUint32(p,true)===0x06054b50){eocd=p;break;}
 if(eocd<0||v.getUint16(eocd+4,true)||v.getUint16(eocd+6,true)||eocd+22+v.getUint16(eocd+20,true)!==data.length)throw Error('不支持的安装包格式');
 const count=v.getUint16(eocd+10,true),centralSize=v.getUint32(eocd+12,true),centralStart=v.getUint32(eocd+16,true);
 if(!count||count>MAX_FILES||v.getUint16(eocd+8,true)!==count||centralStart+centralSize!==eocd)throw Error('安装包目录异常');
 const files=new Map();let pos=centralStart,total=0;
 for(let i=0;i<count;i++){
  if(pos+46>eocd||v.getUint32(pos,true)!==0x02014b50)throw Error('安装包目录损坏');
  const flags=v.getUint16(pos+8,true),method=v.getUint16(pos+10,true),crc=v.getUint32(pos+16,true),compressed=v.getUint32(pos+20,true),size=v.getUint32(pos+24,true),n=v.getUint16(pos+28,true),extra=v.getUint16(pos+30,true),comment=v.getUint16(pos+32,true),local=v.getUint32(pos+42,true),mode=v.getUint32(pos+38,true)>>>16;
  if(pos+46+n+extra+comment>eocd||flags&~0x800||![0,8].includes(method)||!([0,0x8000].includes(mode&0xf000))||v.getUint16(pos+34,true)||size>MAX||(total+=size)>MAX)throw Error('安装包包含不支持的文件');
  const name=decoder.decode(data.slice(pos+46,pos+46+n));if(!safePath(name)||files.has(name))throw Error('安装包路径不安全或重复');
  if(local+30>centralStart||v.getUint32(local,true)!==0x04034b50||v.getUint16(local+6,true)!==flags||v.getUint16(local+8,true)!==method||v.getUint32(local+14,true)!==crc||v.getUint32(local+18,true)!==compressed||v.getUint32(local+22,true)!==size)throw Error('安装包文件头不一致');
  const ln=v.getUint16(local+26,true),le=v.getUint16(local+28,true),start=local+30+ln+le;
  if(start+compressed>centralStart||decoder.decode(data.slice(local+30,local+30+ln))!==name)throw Error('安装包文件内容异常');
  const content=method===0?data.slice(start,start+compressed):await inflate(data.slice(start,start+compressed),size);
  if(content.length!==size||crc32(content)!==crc)throw Error('安装包文件校验失败');files.set(name,content);pos+=46+n+extra+comment;
 }
 if(pos!==eocd||!files.has('manifest.json'))throw Error('安装包缺少根目录 manifest.json');return files;
}
export function validatePackage(files,version,current){
 const manifest=JSON.parse(decoder.decode(files.get('manifest.json')));
 if(manifest.manifest_version!==3||manifest.name!==current.name||manifest.version!==version||compareVersions(version,current.version)<=0||manifest.key!==current.key||manifest.update_url!==current.update_url||manifest.minimum_chrome_version!==current.minimum_chrome_version)throw Error('安装包身份或版本不符合升级要求');
 // New permissions require the normal Chrome installation/consent flow.
 for(const field of ['permissions','host_permissions','optional_permissions','optional_host_permissions'])if((manifest[field]||[]).some(p=>!(current[field]||[]).includes(p)))throw Error('新版需要新的权限，请使用下载升级');
 const required=[manifest.background?.service_worker,manifest.options_page,...Object.values(manifest.icons||{}),...(manifest.content_scripts||[]).flatMap(s=>[...(s.js||[]),...(s.css||[])])];
 if(required.some(p=>!p||!files.has(p)))throw Error('安装包缺少必需文件');return manifest;
}
export async function fetchPackage(release,current,fetch=globalThis.fetch){
 async function asset(name,limit){
  const a=release.assets[name];
  if(!/^https:\/\/api\.github\.com\/repos\/chenyanshan\/bilibili-ad-skipper\/releases\/assets\/[1-9]\d*$/.test(a.apiUrl))throw Error('安装附件来源不正确');
  const r=await fetch(a.apiUrl,{credentials:'omit',headers:{Accept:'application/octet-stream'},signal:AbortSignal.timeout(45000)});
  if(!r.ok)throw Error(`下载安装附件失败（HTTP ${r.status}）`);
  if(!['https://api.github.com','https://release-assets.githubusercontent.com'].includes(new URL(r.url||a.apiUrl).origin))throw Error('安装附件跳转到未知来源');
  const reader=r.body.getReader(),chunks=[];let size=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit)throw Error('安装附件过大');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
  if(size!==a.size)throw Error('安装附件大小不一致');const bytes=new Uint8Array(size);let p=0;for(const c of chunks){bytes.set(c,p);p+=c.length;}return bytes;
 }
 const sums=decoder.decode(await asset('SHA256SUMS.txt',8192)),matches=[...sums.matchAll(/^([a-f0-9]{64}) {2}bilibili-ad-skipper\.zip\r?$/gm)];
 if(matches.length!==1)throw Error('安装包校验清单不完整');
 const bytes=await asset('bilibili-ad-skipper.zip',MAX);if(await sha256(bytes)!==matches[0][1])throw Error('安装包 SHA256 校验失败，未修改文件');
 const files=await unpackExtension(bytes);validatePackage(files,release.version,current);return files;
}
