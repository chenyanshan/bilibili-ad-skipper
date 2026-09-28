import fs from 'node:fs';import path from 'node:path';
const version=process.argv[2];
if(!/^\d+\.\d+\.\d+$/.test(version||'')||version.split('.').some(n=>Number(n)>65535||String(Number(n))!==n))throw Error('用法：npm run version:set -- X.Y.Z（不带 v，不允许前导零）');
const root=path.resolve(import.meta.dirname,'..');
for(const file of ['package.json','extension/manifest.json']){const p=path.join(root,file),data=JSON.parse(fs.readFileSync(p,'utf8'));data.version=version;fs.writeFileSync(p,JSON.stringify(data,null,2)+'\n');}
console.log(`Updated package.json and extension/manifest.json to ${version}`);
