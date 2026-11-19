const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const express = require('express');
const {createCallbackService,normalizeCallback,normalizeDraft} = require('./callback-service');
const {mountCallbackRoutes,injectCallbackPage} = require('./callback-routes');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(),'ih-page-test-'));
const client = fs.readFileSync(path.join(__dirname,'public/callback-page.js'),'utf8');
let server;
async function main() {
  assert.equal(normalizeCallback().page_enabled,false);
  assert.throws(() => normalizeCallback({page_enabled:1}),/CALLBACK_CONFIG_INVALID/);
  const step = {name:'Refresh user',type:'page_refresh',enabled:true,timeout_ms:1000};
  assert.equal(normalizeDraft({name:'Page',steps:[{...step,code:'never execute this'}]}).steps[0].code,'');
  let clock = Date.now();
  const site = {id:'demo',enabled:true,proxyPrefix:'/666',externalCallback:{...normalizeCallback(),page_enabled:true}};
  const other = {id:'other',enabled:true,proxyPrefix:'/other',externalCallback:{...site.externalCallback}};
  const root = {id:'root',enabled:true,proxyPrefix:'',externalCallback:{...site.externalCallback}};
  const sites = [site,other,root];
  const file = path.join(tmp,'state.json');
  const getSite = id => sites.find(s=>s.id===id);
  const service = createCallbackService({stateFile:file,getSite,now:()=>clock});
  const template = service.publish(service.save(null,{name:'Refresh workflow',steps:[
    {name:'Before',type:'server_node',code:'return {...input,before:true};',timeout_ms:1000},step,
    {name:'After',type:'server_node',code:'return {...input,after:true};',timeout_ms:1000},
  ]}).id);
  site.externalCallback.template_id = template.id;
  assert.ok(!injectCallbackPage('<head></head>',{id:'demo',externalCallback:{}}).includes('page-client'));
  assert.ok(injectCallbackPage('<head></head>',site).includes('data-ih-callback-site="demo"'));
  assert.throws(()=>service.registerPage('demo',{order_ref:'x',path:'/other/'}),/BINDING_INVALID/);
  assert.throws(()=>service.registerPage('demo',{order_ref:'x',path:'//evil.invalid/666/'}),/BINDING_INVALID/);
  assert.throws(()=>service.registerPage('demo',{order_ref:'x',path:'/666/../admin'}),/BINDING_INVALID/);
  assert.throws(()=>service.registerPage('demo',{order_ref:'x',path:'/666/?a=1'}),/BINDING_INVALID/);
  const a = service.registerPage('demo',{order_ref:'order-1',path:'/666/login'});
  const b = service.registerPage('demo',{order_ref:'order-1',path:'/666/login'});
  assert.notEqual(a.page_ref,b.page_ref);
  assert.ok(!JSON.stringify(service.list()).includes(a.secret));
  const auth = p => ({page_ref:p.page_ref,secret:p.secret});
  assert.throws(()=>service.pollPage('other',auth(a),null,1),/SESSION_INVALID/);
  assert.throws(()=>service.pollPage('demo',{...auth(a),secret:'wrong'},null,1),/SESSION_INVALID/);
  const j = service.test(template.id,'demo',{event_id:'test-page',order_ref:'order-1',page_ref:a.page_ref,amount:2});
  assert.equal((await service.run(j.id)).status,'waiting_page');
  assert.equal(await service.pollPage('demo',auth(b),null,5),null);
  const cmd = await service.pollPage('demo',auth(a),null,5);
  assert.equal(cmd.job_id,j.id);assert.equal(cmd.action,'reload');assert.equal(cmd.path,'/666/login');
  assert.equal(cmd.step,1);assert.ok(!JSON.stringify(cmd).includes('amount'));
  assert.throws(()=>service.acknowledgePage('demo',{...auth(a),job_id:'wrong',step:1}),/COMMAND_INVALID/);
  service.toggle(template.id,false);
  assert.equal(await service.pollPage('demo',auth(a),null,5),null);
  service.toggle(template.id,true);
  service.acknowledgePage('demo',{...auth(a),...cmd});
  assert.throws(()=>service.acknowledgePage('demo',{...auth(a),...cmd}),/SESSION_INVALID/);
  const complete = await service.run(j.id);
  assert.equal(complete.status,'completed');assert.equal(complete.payment_verified,false);
  assert.equal(complete.input.before,true);assert.equal(complete.input.after,true);
  assert.equal(complete.results[1].trusted,false);
  const wrongOrder = service.test(template.id,'demo',{order_ref:'wrong-order',page_ref:b.page_ref});
  assert.equal((await service.run(wrongOrder.id)).error,'CALLBACK_PAGE_BINDING_INVALID');
  const missing = service.test(template.id,'demo',{});
  assert.equal((await service.run(missing.id)).status,'failed');
  const noPage = service.test(template.id,'demo',{order_ref:'order-1',page_ref:b.page_ref});
  site.externalCallback.page_enabled = false;
  assert.equal((await service.run(noPage.id)).error,'CALLBACK_PAGE_DISABLED');
  assert.throws(()=>service.registerPage('demo',{order_ref:'x',path:'/666/'}),/PAGE_DISABLED/);
  site.externalCallback.page_enabled = true;
  const abort = new AbortController();
  const waiting = service.pollPage('demo',auth(b),abort.signal,500);
  assert.throws(()=>service.pollPage('demo',auth(b),null,1),/PAGE_BUSY/);
  abort.abort();assert.equal(await waiting,null);
  assert.equal(await service.pollPage('demo',auth(b),null,1),null);
  const recoverJob = service.test(template.id,'demo',{order_ref:'order-1',page_ref:b.page_ref});
  await service.run(recoverJob.id);
  const recovered = createCallbackService({stateFile:file,getSite,now:()=>clock});
  assert.equal(recovered.job(recoverJob.id).status,'needs_review');
  clock += 30*60*1000+1;
  assert.equal(service.list().jobs.find(v=>v.id===recoverJob.id).status,'failed');
  assert.throws(()=>service.pollPage('demo',auth(b),null,1),/SESSION_INVALID/);

  const app = express();
  mountCallbackRoutes(app,{service,adminBase:'/manage',getSites:()=>sites,ensureAuth:(req,res,next)=>res.sendStatus(401)});
  server = await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const base = 'http://127.0.0.1:'+server.address().port;
  const post = (siteId,action,body,origin=base) => fetch(base+'/__ih/callback/page/'+siteId+'/'+action,{
    method:'POST',headers:{'Content-Type':'application/json',...(origin?{Origin:origin}:{})},body:JSON.stringify(body),
  });
  assert.equal((await post('demo','register',{order_ref:'http-order',path:'/666/'})).status,200);
  assert.equal((await post('demo','register',{order_ref:'http-order',path:'/666/'},'https://evil.invalid')).status,403);
  assert.equal((await post('demo','register',{order_ref:'http-order',path:'/666/'},null)).status,403);
  assert.equal((await post('root','register',{order_ref:'http-order',path:'/666/'})).status,400);
  assert.equal((await post('root','register',{order_ref:'http-order',path:'/manage/'})).status,400);
  const js = await fetch(base+'/__ih/callback/page-client.js');
  assert.equal(js.status,200);assert.equal(await js.text(),client);
  assert.equal((await post('demo','ack',{page_ref:'random',secret:'random',job_id:'random'})).status,401);
  await testAutomatic();
  await testClient();
  console.log('PASS: user-page refresh is session/order/site bound, one-use acknowledged, opt-in, non-broadcast, expiry/restart safe; client performs no idle polling and refreshes only after ACK.');
}
async function testAutomatic() {
  const secret = crypto.randomBytes(32).toString('hex');
  const site = {id:'auto',enabled:true,proxyPrefix:'/auto',externalCallback:{...normalizeCallback(),page_enabled:true,auto_run:true}};
  const svc = createCallbackService({stateFile:path.join(tmp,'auto.json'),getSite:id=>id==='auto'?site:null,env:{IH_CALLBACK_SIGNING_KEY:secret}});
  const t = svc.publish(svc.save(null,{name:'Automatic refresh',steps:[{name:'refresh',type:'page_refresh'},{name:'after',type:'server_node',code:'return {...input,continued:true};'}]}).id);
  site.externalCallback.template_id = t.id; site.externalCallback.enabled = true;
  const p = svc.registerPage('auto',{order_ref:'order-auto',path:'/auto/'});
  const body = Buffer.from(JSON.stringify({event_id:'auto-page',page_ref:p.page_ref,order_ref:'order-auto'}));
  const timestamp = String(Math.floor(Date.now()/1000));
  const signature = crypto.createHmac('sha256',secret).update(timestamp+'.auto.').update(body).digest('hex');
  const accepted = svc.receive('auto',body,{'x-ih-timestamp':timestamp,'x-ih-signature':signature});
  const credentials = {page_ref:p.page_ref,secret:p.secret};
  const command = await svc.pollPage('auto',credentials,null,2000);
  assert.equal(command.job_id,accepted.job_id);
  assert.equal(svc.list().active_page_count,1);
  site.externalCallback.enabled = false;
  assert.throws(()=>svc.acknowledgePage('auto',{...credentials,...command}),/COMMAND_INVALID/);
  site.externalCallback.enabled = true;
  svc.acknowledgePage('auto',{...credentials,...command});
  for(let i=0;i<100 && svc.job(accepted.job_id).status!=='completed';i++)await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(svc.job(accepted.job_id).status,'completed');
  assert.equal(svc.job(accepted.job_id).input.continued,true);
  assert.equal(svc.list().active_page_count,0);
  assert.equal(svc.receive('auto',body,{'x-ih-timestamp':timestamp,'x-ih-signature':signature}).duplicate,true);
}
async function testClient() {
  const flush = async() => { for(let i=0;i<40;i++)await Promise.resolve(); };
  for (const mode of ['ok','unknown','ack-failed']) {
    const calls = [];let reloads = 0;
    const storage = new Map();
    const context = {
      window:{},document:{currentScript:{dataset:{ihCallbackSite:'demo'}}},
      location:{pathname:'/666/',reload(){reloads++;}},
      sessionStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
      AbortController,Date,setTimeout(){},
      async fetch(url,options) {
        calls.push({url,options});
        if (url.endsWith('/register')) return {ok:true,json:async()=>({data:{page_ref:'a'.repeat(48),secret:'b'.repeat(64),expires_at:Date.now()+10000}})};
        if (url.endsWith('/poll')) return {ok:true,json:async()=>({data:{job_id:'job',step:1,path:'/666/',action:mode==='unknown'?'eval':'reload'}})};
        if (url.endsWith('/ack')) return mode==='ack-failed' ? {ok:false,status:503} : {ok:true,json:async()=>({ok:true})};
        throw new Error('Unexpected request');
      },
    };
    vm.runInNewContext(client,context);
    assert.equal(calls.length,0);
    const bound = await context.window.IHCallbackPage.bind('client-order');
    assert.equal(bound.secret,undefined);
    await flush();
    assert.equal(reloads,mode==='ok'?1:0);
    for(const c of calls)assert.equal(c.options.credentials,'omit');
    if(mode==='ok')assert.equal(storage.size,0);
    if(mode==='unknown')assert.ok(!calls.some(c=>c.url.endsWith('/ack')));
    context.window.IHCallbackPage.stop();
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{
  if(server)await new Promise(resolve=>server.close(resolve));
  fs.rmSync(tmp,{recursive:true,force:true});
});
