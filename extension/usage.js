// Local observations, never an account balance or a monetary estimate.
const DAY=86400000;
export function createUsageTracker({storage,now=Date.now}) {
  let queue=Promise.resolve();
  const serial=task=>{const next=queue.then(task,task);queue=next.catch(()=>{});return next;};
  async function identity(provider){
    const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([provider.url,provider.key])));
    return 'jevUsage:'+Array.from(new Uint8Array(hash),x=>x.toString(16).padStart(2,'0')).join('');
  }
  function retained(rows){return (Array.isArray(rows)?rows:[]).filter(r=>Number.isInteger(r.day)&&r.day<=Math.floor(now()/DAY)&&r.day>Math.floor(now()/DAY)-90);}
  async function record(provider,day,reply){
    const key=await identity(provider);
    return serial(async()=>{
      const usage=reply?.usage;
      const rows=retained((await storage.get(key))[key]);
      let row=rows.find(r=>r.day===day);
      if(!row){row={day,requests:0,input:0,output:0,unknown:0,cost:0,unpriced:0};rows.push(row);}
      row.requests++;
      const valid=n=>Number.isSafeInteger(n)&&n>=0;
      if(valid(usage?.input_tokens))row.input+=usage.input_tokens;
      if(valid(usage?.output_tokens))row.output+=usage.output_tokens;
      if(!valid(usage?.input_tokens)||!valid(usage?.output_tokens))row.unknown++;
      const model=reply?.model||provider.model;
      const priced=provider.url==='https://api.typesafe.ai/v1/systemone'&&model==='jev-1.13.0'&&valid(usage?.input_tokens);
      if(priced)row.cost+=usage.input_tokens*0.042/1e6;else row.unpriced++;
      await storage.set({[key]:rows});
    });
  }
  return {
    async request(provider,ask){
      const day=Math.floor(now()/DAY);let reply;
      try{reply=await ask();return reply;}finally{
        // Accounting failure must not invalidate an otherwise usable ad decision.
        await record(provider,day,reply).catch(()=>{});
      }
    },
    async summary(provider){
      const key=await identity(provider);
      return serial(async()=>{
        const rows=retained((await storage.get(key))[key]);
        const sum=list=>list.reduce((total,r)=>Object.fromEntries(Object.keys(total).map(k=>[k,total[k]+(r[k]||0)])),{requests:0,input:0,output:0,unknown:0,cost:0,unpriced:0});
        return {recent:sum(rows),today:sum(rows.filter(r=>r.day===Math.floor(now()/DAY))),days:rows.length};
      });
    }
  };
}
