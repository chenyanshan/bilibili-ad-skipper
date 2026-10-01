import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {spawnSync} from 'node:child_process';
import {unpackExtension,validatePackage,fetchPackage,sha256} from '../extension/update-package.js';
import {parseRelease,RELEASES} from '../extension/updates.js';
const current=JSON.parse(fs.readFileSync(new URL('../extension/manifest.json',import.meta.url)));
function zip(entries,method='deflate'){
 const py="import sys,json,io,zipfile,base64\nj=json.load(sys.stdin);b=io.BytesIO()\nwith zipfile.ZipFile(b,'w',compression=zipfile.ZIP_DEFLATED if j['method']=='deflate' else zipfile.ZIP_STORED) as z:\n for name,body in j['entries']:z.writestr(name,body)\nsys.stdout.buffer.write(b.getvalue())";
 const r=spawnSync('python3',['-c',py],{input:JSON.stringify({entries,method})});assert.equal(r.status,0,r.stderr.toString());return new Uint8Array(r.stdout);
}
function packageFiles(version='0.8.0',patch={}){const m={...current,version,...patch};return [['manifest.json',JSON.stringify(m)],...new Set([m.background.service_worker,m.options_page,...Object.values(m.icons),...m.content_scripts.flatMap(s=>s.js)])].map(x=>Array.isArray(x)?x:[x,'fixture']);}
test('bounded ZIP parser accepts deflate/store and verifies contents',async()=>{
 for(const method of ['deflate','store']){const entries=packageFiles(),files=await unpackExtension(zip(entries,method));assert.equal(new TextDecoder().decode(files.get('background.js')),'fixture');assert.equal(validatePackage(files,'0.8.0',current).version,'0.8.0');}
});
test('path traversal, duplicate entries, missing root, corrupt and oversized ZIP rejected',async()=>{
 for(const entries of [[['../escape.js','bad']],[['manifest.json','{}'],['manifest.json','{}']],[['outer/manifest.json','{}']],[['/abs.js','bad']],[['x\\y.js','bad']],[['evil.exe','bad']]])await assert.rejects(unpackExtension(zip(entries)));
 const damaged=zip(packageFiles(),'store');damaged[40]^=1;await assert.rejects(unpackExtension(damaged));await assert.rejects(unpackExtension(new Uint8Array(9*1024*1024)));
});
test('wrong identity, same/downgrade version, new permissions or missing entrypoints cannot install',async()=>{
 for(const patch of [{name:'other'},{manifest_version:2},{key:'new-key'},{permissions:[...current.permissions,'debugger']},{host_permissions:[...current.host_permissions,'https://evil.example/*']}]){const files=await unpackExtension(zip(packageFiles('0.8.0',patch)));assert.throws(()=>validatePackage(files,'0.8.0',current));}
 for(const version of ['0.0.1',current.version]){const files=await unpackExtension(zip(packageFiles(version)));assert.throws(()=>validatePackage(files,version,current));}
 const files=await unpackExtension(zip(packageFiles()));files.delete('background.js');assert.throws(()=>validatePackage(files,'0.8.0',current));
});
test('download verifies pinned asset source, advertised lengths and SHA256 before parsing',async()=>{
 const bytes=zip(packageFiles()),digest=await sha256(bytes),sums=new TextEncoder().encode(digest+'  bilibili-ad-skipper.zip\n');
 const raw={tag_name:'v0.8.0',html_url:RELEASES+'/tag/v0.8.0',assets:[['bilibili-ad-skipper.zip',bytes],['SHA256SUMS.txt',sums]].map(([name,b],i)=>({id:10+i,name,size:b.length,state:'uploaded',browser_download_url:RELEASES+'/download/v0.8.0/'+name}))};
 const release=parseRelease(raw),fetch=async url=>new Response(url.endsWith('/11')?sums:bytes);
 assert.ok((await fetchPackage(release,current,fetch)).has('manifest.json'));
 await assert.rejects(fetchPackage(release,current,async url=>new Response(url.endsWith('/11')?new TextEncoder().encode('0'.repeat(64)+'  bilibili-ad-skipper.zip\n'):bytes)),/SHA256/);
 const forged=structuredClone(release);forged.assets['SHA256SUMS.txt'].apiUrl='https://evil.example/sums';await assert.rejects(fetchPackage(forged,current,fetch),/来源/);
 const bad=structuredClone(release);bad.assets['bilibili-ad-skipper.zip'].size++;await assert.rejects(fetchPackage(bad,current,fetch),/大小/);
});
