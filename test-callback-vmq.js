const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const {createCallbackService,normalizeCallback} = require('./callback-service');
const {mountCallbackRoutes} = require('./callback-routes');

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(),'ih-vmq-'));
  let server;
  let vmqServer;
  const previousEnv = { ...process.env };
  try {
    const key = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    const env = {IH_CALLBACK_VMQ_KEY:key,IH_CALLBACK_OTHER:crypto.randomBytes(32).toString('hex')};
    const site = {id:'demo',enabled:true,externalCallback:normalizeCallback()};
    const other = {id:'other',enabled:true,externalCallback:normalizeCallback()};
    const getSite = id => [site,other].find(s=>s.id===id);
    const file = path.join(tmp,'state.json');
    const service = createCallbackService({stateFile:file,getSite,env,now:()=>now});
    const template = service.publish(service.save(null,{name:'VMQ test',ack_body:'custom-json-ack',steps:[{type:'server_node',name:'Normalize',code:'return {payId:input.payId,amount:input.reallyPrice,provider:input.provider};',timeout_ms:1000}]}).id);
    site.externalCallback = normalizeCallback({enabled:true,template_id:template.id,vmq_enabled:true});
    other.externalCallback = normalizeCallback({enabled:true,template_id:template.id,vmq_enabled:true,vmq_key_env:'IH_CALLBACK_OTHER'});
    const payload = {payId:'order-123',param:'用户A + / test',type:'2',price:'1.00',reallyPrice:'1.01',signType:'HMAC_SHA256',eventId:'payment-vmq123',timestamp:String(now),nonce:'a'.repeat(32)};
    const signed = (changes={},secret=key) => {
      const fields = {...payload,...changes};
      for (const k of Object.keys(fields)) if (fields[k] === null) delete fields[k];
      const canonical = Object.keys(fields).sort().map(k=>k+'='+fields[k]).join('&');
      return new URLSearchParams({...fields,sign:crypto.createHmac('sha256',secret).update(canonical).digest('hex')}).toString();
    };
    const expect = (fn,code) => assert.throws(fn,e=>e.message===code);
    const first = service.receiveVmq('demo',signed());
    assert.equal(first.ack_body,'success');
    assert.equal(first.duplicate,false);
    assert.equal(service.job(first.job_id).source,'signed_vmq');
    assert.equal(service.job(first.job_id).payment_verified,false);
    assert.equal(service.job(first.job_id).event.param,payload.param);
    assert.equal(service.receiveVmq('demo',signed({nonce:'b'.repeat(32)})).job_id,first.job_id);
    assert.equal(service.list().jobs.length,1);
    expect(()=>service.receiveVmq('demo',signed({reallyPrice:'2.00'})),'CALLBACK_EVENT_CONFLICT');
    expect(()=>service.receiveVmq('demo',signed({payId:'another-order'})),'CALLBACK_EVENT_CONFLICT');
    expect(()=>service.receiveVmq('other',signed()),'CALLBACK_SIGNATURE_INVALID');
    expect(()=>service.receiveVmq('demo',signed({},'wrong'.repeat(10))),'CALLBACK_SIGNATURE_INVALID');
    expect(()=>service.receiveVmq('demo',signed().replace('reallyPrice=1.01','reallyPrice=9.99')),'CALLBACK_SIGNATURE_INVALID');
    expect(()=>service.receiveVmq('demo',signed()+'&price=1.00'),'CALLBACK_VMQ_PARAMS_INVALID');
    expect(()=>service.receiveVmq('demo',signed({eventId:'payment-无订单转账-2-123'})),'CALLBACK_VMQ_PARAMS_INVALID');
    expect(()=>service.receiveVmq('demo',signed({payId:'x&payId=y'})),'CALLBACK_VMQ_PARAMS_INVALID');
    expect(()=>service.receiveVmq('demo',signed({price:'0.00'})),'CALLBACK_VMQ_PARAMS_INVALID');
    expect(()=>service.receiveVmq('demo',signed({type:'3'})),'CALLBACK_VMQ_PARAMS_INVALID');
    expect(()=>service.receiveVmq('demo',signed({timestamp:String(now+300001)})),'CALLBACK_VMQ_PARAMS_INVALID');
    expect(()=>service.receiveVmq('demo',signed({signType:'MD5'})),'CALLBACK_SIGNATURE_INVALID');
    expect(()=>service.receiveVmq('demo',signed({nonce:null})),'CALLBACK_VMQ_PARAMS_INVALID');
    expect(()=>service.receiveVmq('demo',signed()+'&extra=x'),'CALLBACK_VMQ_PARAMS_INVALID');
    expect(()=>service.receiveVmq('demo','x=%zz'),'CALLBACK_VMQ_PARAMS_INVALID');
    expect(()=>service.receiveVmq('demo','x'.repeat(12001)),'CALLBACK_DATA_TOO_LARGE');
    const retry = service.receiveVmq('demo',signed({eventId:'payment-old',timestamp:String(now-86400000)}));
    assert.equal(retry.ack_body,'success');
    const completed = await service.run(first.job_id);
    assert.equal(completed.status,'completed');
    assert.deepEqual(completed.input,{payId:'order-123',amount:'1.01',provider:'vmq'});
    const restored = createCallbackService({stateFile:file,getSite,env,now:()=>now});
    assert.equal(restored.receiveVmq('demo',signed({nonce:'c'.repeat(32)})).job_id,first.job_id);
    const disk = fs.readFileSync(file,'utf8');
    assert.ok(!disk.includes(key));
    assert.ok(!disk.includes('nonce'));
    assert.ok(!disk.includes('"sign"'));
    site.externalCallback.vmq_enabled=false;
    expect(()=>service.receiveVmq('demo',signed()),'CALLBACK_VMQ_DISABLED');
    await assert.rejects(service.run(retry.job_id),/CALLBACK_EXECUTION_PAUSED/);
    site.externalCallback.vmq_enabled=true;
    site.externalCallback.enabled=false;
    expect(()=>service.receiveVmq('demo',signed()),'CALLBACK_VMQ_DISABLED');
    site.externalCallback.enabled=true;
    const savedKey=env.IH_CALLBACK_VMQ_KEY;delete env.IH_CALLBACK_VMQ_KEY;
    expect(()=>service.receiveVmq('demo',signed()),'CALLBACK_VMQ_KEY_MISSING');
    env.IH_CALLBACK_VMQ_KEY=savedKey;
    assert.equal(service.bindingStatus('demo').vmq_key_configured,true);
    const app=express();
    mountCallbackRoutes(app,{service,adminBase:'/admin',getSites:()=>[site,other],ensureAuth:(req,res)=>res.sendStatus(401)});
    server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
    const url='http://127.0.0.1:'+server.address().port+'/__ih/callback/vmq/demo';
    const response=await fetch(url+'?'+signed());
    assert.equal(response.status,200);
    assert.equal(await response.text(),'success');
    assert.equal(response.headers.get('cache-control'),'no-store');
    assert.equal(response.headers.get('x-ih-job-id'),first.job_id);
    assert.equal((await fetch(url+'?'+signed({},'invalid'.repeat(8)))).status,401);
    assert.equal((await fetch(url+'?'+signed()+'&type=2')).status,400);
    assert.equal((await fetch(url,{method:'POST'})).status,404);
    for(let i=0;i<30;i++) await fetch(url);
    assert.equal((await fetch(url)).status,429);
    fs.writeFileSync(path.join(tmp,'broken.json'),'invalid');
    const broken=createCallbackService({stateFile:path.join(tmp,'broken.json'),getSite,env});
    expect(()=>broken.receiveVmq('demo',signed()),'CALLBACK_STORAGE_UNAVAILABLE');
    const vmqApp = express();
    const requests = [];
    let reply = 'success';
    vmqApp.post('/createOrder', express.urlencoded({ extended:false }), (req,res) => {
      requests.push(req.body);
      if (reply === 'unavailable') return res.sendStatus(502);
      if (reply === 'rejected') return res.json({code:-1});
      res.json({code:1,data:{payId:req.body.payId,orderId:'vmq-new',reallyPrice:1.02,
        accessToken:'checkout-token',payUrl:'https://qr.example.test/own?value=a+b'}});
    });
    vmqServer = vmqApp.listen(0,'127.0.0.1');
    await new Promise(resolve => vmqServer.once('listening',resolve));
    process.env.IH_VMQ_API_ORIGIN = 'http://127.0.0.1:' + vmqServer.address().port;
    process.env.IH_VMQ_CHECKOUT_ORIGIN = 'https://pay.example.test';
    process.env.IH_VMQ_CALLBACK_ORIGIN = 'https://host.example.test';
    process.env.IH_CALLBACK_VMQ_KEY = key;

    await new Promise(resolve => server.close(resolve));
    const checkoutApp = express();
    mountCallbackRoutes(checkoutApp,{service,adminBase:'/admin',getSites:()=>[site,other],
      ensureAuth:(req,res,next)=>req.get('authorization')==='Bearer test' ? next() : res.sendStatus(401)});
    server = checkoutApp.listen(0,'127.0.0.1');
    await new Promise(resolve => server.once('listening',resolve));
    const checkoutUrl = 'http://127.0.0.1:' + server.address().port + '/admin/api/callbacks/vmq/checkout';
    const checkout = (override = {}, token = 'test') => fetch(checkoutUrl, {
      method:'POST', headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},
      body:JSON.stringify({site_id:'demo',pay_id:'new-order',price:'1.00',type:'2',...override}),
    });
    assert.equal((await checkout({},'invalid')).status,401);
    assert.equal((await checkout({price:'1.005'})).status,400);
    site.externalCallback.vmq_enabled = false;
    assert.equal((await checkout()).status,409);
    site.externalCallback.vmq_enabled = true;
    assert.equal(requests.length,0);
    const created = await checkout();
    assert.equal(created.status,201);
    const { data: order } = await created.json();
    assert.equal(order.amountDue,'1.02');
    assert.equal(new URL(order.checkoutUrl).searchParams.get('accessToken'),'checkout-token');
    assert.equal(new URL(order.qrImageUrl).searchParams.get('url'),order.qrCodeContent);
    const publicUrl = 'http://127.0.0.1:' + server.address().port + '/__ih/vmq/checkout/demo?pay_id=order-123&price=1.00&type=2';
    const publicOrder = await fetch(publicUrl,{redirect:'manual'});
    assert.equal(publicOrder.status,302);
    assert.equal(publicOrder.headers.get('location'),order.checkoutUrl);
    assert.equal((await fetch(publicUrl.replace('/demo?','/missing?'),{redirect:'manual'})).status,404);
    site.externalCallback.enabled = false;
    assert.equal((await fetch(publicUrl,{redirect:'manual'})).status,302);
    site.externalCallback.enabled = true;
    const {sign,notifyUrl,...fields} = requests[0];
    assert.equal(notifyUrl,'https://host.example.test/__ih/callback/vmq/demo');
    const canonical = Object.keys(fields).sort().map(k=>k+'='+fields[k]).join('&');
    assert.equal(sign,crypto.createHmac('sha256',key).update(canonical).digest('hex'));
    reply = 'rejected';
    assert.equal((await (await checkout()).json()).message,'VMQ_CHECKOUT_REJECTED');
    reply = 'unavailable';
    assert.equal((await (await checkout()).json()).message,'VMQ_CHECKOUT_STATUS_UNKNOWN');
    assert.equal(requests.length,5);
    console.log('PASS: VMQ signed callback, admin and public checkout, script handoff, QR variables, failure handling and authentication. Only local mock orders were created.');
  } finally {
    if(server) await new Promise(r=>server.close(r));
    if(vmqServer) await new Promise(r=>vmqServer.close(r));
    for (const key of ['IH_VMQ_API_ORIGIN','IH_VMQ_CHECKOUT_ORIGIN','IH_VMQ_CALLBACK_ORIGIN','IH_CALLBACK_VMQ_KEY']) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
    fs.rmSync(tmp,{recursive:true,force:true});
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
