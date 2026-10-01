import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {DEFAULTS} from '../extension/core.js';
const root=path.resolve(import.meta.dirname,'..');
const read=p=>JSON.parse(fs.readFileSync(path.join(root,p),'utf8'));
const pkg=read('package.json'),manifest=read('extension/manifest.json');
if(!/^\d+\.\d+\.\d+$/.test(pkg.version)||pkg.version.split('.').some(n=>Number(n)>65535))throw Error('版本必须为 Chrome 支持的 X.Y.Z');
if(pkg.version!==manifest.version)throw Error('package.json 与 manifest.json 版本不一致，请用 npm run version:set -- X.Y.Z');
if(DEFAULTS.provider!=='jev'||DEFAULTS.baseUrl||DEFAULTS.model||DEFAULTS.apiKey||DEFAULTS.jevApiKey)throw Error('分发配置必须 JEV 优先、LLM 默认地址/模型和两个 Key 留空');
if(DEFAULTS.communityEnabled!==true||DEFAULTS.communityAutoSubmit!==false)throw Error('社区查询必须默认开启，自动投稿必须默认关闭');
if(!manifest.host_permissions.includes('https://www.bsbsb.top/*'))throw Error('缺少社区接口访问权限');
const required=['core.js','providers.js','jev-analysis.js','community.js','subtitles.js',manifest.background.service_worker,manifest.options_page,...Object.values(manifest.icons),...manifest.content_scripts.flatMap(c=>c.js)];
for(const file of required)if(!fs.existsSync(path.join(root,'extension',file)))throw Error(`缺少扩展文件 ${file}`);
function scan(dir){for(const item of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,item.name);if(item.isDirectory())scan(p);else{
 if(item.name.endsWith('.js'))execFileSync(process.execPath,['--check',p],{stdio:'pipe'});
 if(/\.(js|json|html|css)$/.test(p)&&/(?:sk-|apikey_)[A-Za-z0-9_]{16,}/.test(fs.readFileSync(p,'utf8')))throw Error(`文件疑似包含 Key：${p}`);
}}}
scan(path.join(root,'extension'));
console.log(`Checked extension syntax, defaults and version ${manifest.version}`);
