export const RELEASES='https://github.com/chenyanshan/bilibili-ad-skipper/releases';
export const LATEST_API='https://api.github.com/repos/chenyanshan/bilibili-ad-skipper/releases/latest';
export const UPDATE_KEY='extensionUpdate:v1',DAY=86400000;
export function versionParts(value){
  if(typeof value!=='string'||!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value))throw Error('无效版本号');
  const parts=value.split('.').map(Number);if(parts.some(n=>n>65535))throw Error('无效版本号');return parts;
}
export function compareVersions(a,b){const x=versionParts(a),y=versionParts(b);for(let i=0;i<3;i++)if(x[i]!==y[i])return Math.sign(x[i]-y[i]);return 0;}
export function parseRelease(data){
  if(!data||data.draft||data.prerelease||typeof data.tag_name!=='string'||!data.tag_name.startsWith('v'))throw Error('没有可用的正式版本');
  const version=data.tag_name.slice(1);versionParts(version);
  const page=RELEASES+'/tag/v'+version;if(data.html_url!==page)throw Error('更新来源不正确');
  const assets={};for(const name of ['bilibili-ad-skipper.zip','SHA256SUMS.txt']){
    const a=data.assets?.find(a=>a.name===name),prefix=RELEASES+'/download/v'+version+'/';
    if(!a||a.state!=='uploaded'||a.browser_download_url!==prefix+name||!Number.isSafeInteger(a.id)||a.id<=0||!Number.isFinite(a.size)||a.size<=0||a.size>8*1024*1024)throw Error('新版安装附件尚未准备完整');
    assets[name]={name,url:a.browser_download_url,apiUrl:`https://api.github.com/repos/chenyanshan/bilibili-ad-skipper/releases/assets/${a.id}`,size:a.size};
  }
  return {version,page,notes:typeof data.body==='string'?data.body.slice(0,16000):'',publishedAt:data.published_at,assets};
}
export function createUpdateChecker({storage,fetch=globalThis.fetch,now=Date.now,currentVersion,onChange=async()=>{}}){
  let pending;
  async function status(){const saved=(await storage.get(UPDATE_KEY))[UPDATE_KEY]||{};return {...saved,currentVersion,available:!!saved.release&&compareVersions(saved.release.version,currentVersion)>0,enabled:saved.enabled!==false};}
  async function check(force=false){
    if(pending)return pending;
    pending=(async()=>{
      const saved=await status(),age=now()-(saved.attemptedAt||0);
      if(!force&&!saved.enabled||age>=0&&age<(force?60000:DAY)&&saved.attemptedAt){await onChange(saved);return saved;}
      const state={enabled:saved.enabled,attemptedAt:now(),checkedAt:saved.checkedAt||null,release:saved.release||null,error:null};
      await storage.set({[UPDATE_KEY]:state});
      try{
        const r=await fetch(LATEST_API,{credentials:'omit',redirect:'error',headers:{Accept:'application/vnd.github+json'},signal:AbortSignal.timeout(15000)});
        if(!r.ok)throw Error(r.status===403||r.status===429?'GitHub 暂时限制请求，请稍后再试':`更新检查失败（HTTP ${r.status}）`);
        state.release=parseRelease(await r.json());state.checkedAt=now();
      }catch(e){state.error=e.name==='TimeoutError'||e.name==='AbortError'?'连接 GitHub 超时，请稍后再试':e.name==='TypeError'?'无法连接 GitHub，请稍后再试':e.message||'暂时无法检查更新';}
      // A user may disable automatic checks while the request is pending.
      state.enabled=((await storage.get(UPDATE_KEY))[UPDATE_KEY]||{}).enabled!==false;
      await storage.set({[UPDATE_KEY]:state});const result=await status();await onChange(result);return result;
    })().finally(()=>pending=null);return pending;
  }
  async function setEnabled(enabled){const s=(await storage.get(UPDATE_KEY))[UPDATE_KEY]||{};await storage.set({[UPDATE_KEY]:{...s,enabled:!!enabled}});const result=await status();await onChange(result);return result;}
  return {status,check,setEnabled};
}
