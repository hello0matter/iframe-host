const express = require('express');
const path = require('node:path');
const { createHmac, randomBytes } = require('node:crypto');
const { CallbackError } = require('./callback-service');

function checkoutOrigin(value, allowLoopback = false) {
  try {
    const url = new URL(value);
    const localHttp = allowLoopback && url.protocol === 'http:' &&
      ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
    if ((url.protocol === 'https:' || localHttp) && url.href === url.origin + '/') return url.origin;
  } catch {}
  throw new CallbackError('VMQ_CHECKOUT_NOT_CONFIGURED', 503);
}

async function createVmqCheckout(body, service) {
  const { site_id, pay_id, price, type } = body || {};
  if (typeof site_id !== 'string' || typeof pay_id !== 'string' ||
    !/^[A-Za-z0-9_.:-]{1,128}$/.test(pay_id) || typeof price !== 'string' ||
    !/^(?:0|[1-9]\d{0,8})(?:\.\d{1,2})?$/.test(price) || Number(price) <= 0 ||
    !['1', '2'].includes(type)) throw new CallbackError('VMQ_CHECKOUT_INVALID');
  const publicOrigin = checkoutOrigin(process.env.IH_VMQ_CHECKOUT_ORIGIN, true);
  const apiOrigin = checkoutOrigin(process.env.IH_VMQ_API_ORIGIN || publicOrigin, true);
  const callbackOrigin = checkoutOrigin(process.env.IH_VMQ_CALLBACK_ORIGIN);
  const binding = service.bindingStatus(site_id);
  if (!binding.enabled || !binding.vmq_enabled || !binding.vmq_key_configured ||
    !binding.published_version || !binding.template_enabled || !binding.storage_healthy) {
    throw new CallbackError('VMQ_CHECKOUT_CALLBACK_UNREADY', 409);
  }

  const params = {
    nonce: randomBytes(16).toString('hex'), param: '', payId: pay_id, price,
    signType: 'HMAC_SHA256', timestamp: String(Date.now()), type,
  };
  const canonical = Object.keys(params).sort().map(key => key + '=' + params[key]).join('&');
  const sign = createHmac('sha256', process.env[binding.vmq_key_env]).update(canonical).digest('hex');
  let result;
  try {
    const response = await fetch(apiOrigin + '/createOrder', {
      method: 'POST',
      body: new URLSearchParams({ ...params, sign, notifyUrl: callbackOrigin + binding.vmq_receive_path }),
      signal: AbortSignal.timeout(8000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error();
    result = await response.json();
  } catch {
    throw new CallbackError('VMQ_CHECKOUT_STATUS_UNKNOWN', 502);
  }
  if (result?.code === -1) throw new CallbackError('VMQ_CHECKOUT_REJECTED', 409);
  const order = result?.data;
  if (result?.code !== 1 || order?.payId !== pay_id || typeof order.orderId !== 'string' ||
    !order.orderId || typeof order.accessToken !== 'string' || !order.accessToken ||
    typeof order.payUrl !== 'string' || !order.payUrl || Number(order.reallyPrice) <= 0 ||
    !Number.isFinite(Number(order.reallyPrice))) throw new CallbackError('VMQ_CHECKOUT_STATUS_UNKNOWN', 502);

  const checkout = new URL('/vmq/pay', publicOrigin);
  checkout.search = new URLSearchParams({ orderId: order.orderId, accessToken: order.accessToken });
  const image = new URL('/enQrcode', publicOrigin);
  image.searchParams.set('url', order.payUrl);
  return {
    payId: pay_id, orderId: order.orderId, amountDue: Number(order.reallyPrice).toFixed(2),
    checkoutUrl: checkout.href, qrCodeContent: order.payUrl, qrImageUrl: image.href,
  };
}

function mountCallbackRoutes(app, { service, adminBase, ensureAuth, getSites }) {
  app.get('/__ih/callback/admin.js', (req,res) => {
    res.setHeader('Cache-Control','no-store');
    res.sendFile(path.join(__dirname,'public','callback-admin.js'));
  });
  app.get('/__ih/callback/browser-frame', (req,res) => {
    res.setHeader('Cache-Control','no-store');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline' blob:; worker-src blob:; connect-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'");
    res.sendFile(path.join(__dirname,'public','callback-browser.html'));
  });
  const rate = new Map();
  app.get('/__ih/callback/page-client.js', (req,res) => {
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.sendFile(path.join(__dirname,'public','callback-page.js'));
  });
  app.post('/__ih/callback/page/:siteId/:action', (req,res,next) => {
    let origin;
    try { origin = new URL(req.get('origin')); } catch { return res.status(403).json({error:'CALLBACK_PAGE_ORIGIN_REQUIRED'}); }
    if (origin.host !== req.get('host') || (req.get('sec-fetch-site') && req.get('sec-fetch-site') !== 'same-origin')) return res.status(403).json({error:'CALLBACK_PAGE_ORIGIN_REQUIRED'});
    if ((req.get('content-encoding') || 'identity') !== 'identity' || !/^application\/json(?:;|$)/i.test(req.get('content-type') || '')) return res.status(415).json({error:'CALLBACK_JSON_REQUIRED'});
    if (!['register','poll','ack'].includes(req.params.action)) return res.sendStatus(404);
    const limit = req.params.action === 'register' ? 60 : 1200;
    if (!rateAllowed('page-global:'+req.params.action,limit) || !rateAllowed('page-ip:'+req.params.action+':'+req.ip,limit)) return res.status(429).set('Retry-After','60').json({error:'CALLBACK_RATE_LIMIT'});
    next();
  }, express.json({limit:'2kb',inflate:false}), async(req,res,next) => {
    res.setHeader('Cache-Control','no-store');
    try {
      const body = req.body || {};
      const siteId = req.params.siteId;
      if (req.params.action === 'register') {
        const pathname = body.path;
        const owner = typeof pathname === 'string' && getSites().filter(s => s.enabled && (!s.proxyPrefix || pathname === s.proxyPrefix || pathname.startsWith(s.proxyPrefix+'/'))).sort((a,b) => (b.proxyPrefix || '').length - (a.proxyPrefix || '').length)[0];
        if (owner?.id !== siteId || pathname === adminBase || pathname.startsWith(adminBase+'/')) throw new CallbackError('CALLBACK_PAGE_BINDING_INVALID');
        return res.json({data:service.registerPage(siteId,body)});
      }
      if (req.params.action === 'ack') return res.json(service.acknowledgePage(siteId,body));
      const controller = new AbortController();
      const abort = () => controller.abort();
      res.on('close',abort);
      try { const data = await service.pollPage(siteId,body,controller.signal); if (!res.destroyed) res.json({data}); }
      finally { res.removeListener('close',abort); }
    } catch(e) { next(e); }
  });
  function rateAllowed(bucket,limit) {
    const minute=Math.floor(Date.now()/60000);
    for(const [k,v] of rate) if(v.minute!==minute) rate.delete(k);
    const entry=rate.get(bucket)||{minute,count:0};
    entry.count++;rate.set(bucket,entry);return entry.count<=limit;
  }
  app.get('/__ih/callback/vmq/:siteId', (req,res,next) => {
    res.setHeader('Cache-Control','no-store');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('X-Content-Type-Options','nosniff');
    if (!rateAllowed('vmq-global',120) || !rateAllowed('vmq-site:'+req.params.siteId,30)) return res.status(429).set('Retry-After','60').type('text/plain').send('rate limited');
    try {
      const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?') + 1) : '';
      const result = service.receiveVmq(req.params.siteId,query);
      res.setHeader('X-IH-Job-Id',result.job_id);
      res.status(200).type('text/plain').send(result.ack_body);
    } catch(e) { next(e); }
  });
  app.post('/__ih/callback/:siteId', (req,res,next) => {
    if(!rateAllowed('global',120)||!rateAllowed('site:'+req.params.siteId,30))return res.status(429).set('Retry-After','60').json({error:'CALLBACK_RATE_LIMIT'});
    if ((req.headers['content-encoding'] || 'identity') !== 'identity' || !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) return res.status(415).json({ error: 'CALLBACK_JSON_REQUIRED' });
    next();
  }, express.raw({ type: 'application/json', limit: '64kb', inflate: false }), (req,res,next) => {
    try {
      const result = service.receive(req.params.siteId,req.body,req.headers);
      res.setHeader('Cache-Control','no-store');
      res.setHeader('X-Content-Type-Options','nosniff');
      res.setHeader('X-IH-Job-Id',result.job_id);
      res.status(200).type('text/plain').send(result.ack_body);
    } catch(e) { next(e); }
  });
  const router = express.Router();
  router.use(ensureAuth, express.json({ limit: '96kb' }));
  const route = fn => (req,res,next) => { Promise.resolve().then(() => fn(req,res)).catch(next); };
  router.get('/', route((req,res) => res.json({ ok: true, data: service.list() })));
  router.post('/vmq/checkout', route(async (req,res) => {
    if (!rateAllowed('vmq-checkout-admin', 20)) {
      throw new CallbackError('CALLBACK_RATE_LIMIT', 429);
    }
    const site = getSites().find(site => site.id === req.body?.site_id && site.enabled);
    if (!site) throw new CallbackError('VMQ_CHECKOUT_CALLBACK_UNREADY', 409);
    res.status(201).json({ ok: true, data: await createVmqCheckout(req.body, service) });
  }));
  router.post('/templates', route((req,res) => res.status(201).json({ ok: true, data: service.save(null,req.body) })));
  router.put('/templates/:id', route((req,res) => res.json({ ok: true, data: service.save(req.params.id,req.body) })));
  router.post('/templates/:id/publish', route((req,res) => res.json({ ok: true, data: service.publish(req.params.id) })));
  router.post('/templates/:id/toggle', route((req,res) => res.json({ ok: true, data: service.toggle(req.params.id,req.body.enabled) })));
  router.delete('/templates/:id', route((req,res) => res.json({ ok: true, data: service.remove(req.params.id,getSites().map(s => s.externalCallback?.template_id)) })));
  router.post('/templates/:id/test', route((req,res) => res.status(201).json({ ok: true, data: service.test(req.params.id,req.body.site_id,req.body.input) })));
  router.get('/status/:siteId', route((req,res) => res.json({ok:true,data:service.bindingStatus(req.params.siteId)})));
  router.get('/jobs/:id', route((req,res) => res.json({ ok: true, data: service.job(req.params.id) })));
  router.post('/jobs/:id/run', route(async(req,res) => res.json({ ok: true, data: await service.run(req.params.id) })));
  router.post('/jobs/:id/browser', route((req,res) => res.json({ ok: true, data: service.browserStep(req.params.id) })));
  router.post('/jobs/:id/browser-result', route((req,res) => res.json({ ok: true, data: service.browserResult(req.params.id,req.body) })));
  router.post('/jobs/:id/review', route((req,res) => res.json({ ok: true, data: service.review(req.params.id) })));
  app.use(adminBase + '/api/callbacks',router);
  app.use((error,req,res,next) => {
    if (!req.path.startsWith('/__ih/callback/') && !req.path.startsWith(adminBase + '/api/callbacks')) return next(error);
    const status = error instanceof CallbackError ? error.status : error.type === 'entity.too.large' ? 413 : error instanceof SyntaxError ? 400 : 500;
    res.status(status).json({ error: error instanceof CallbackError ? error.message : status === 413 ? 'CALLBACK_DATA_TOO_LARGE' : 'CALLBACK_REQUEST_FAILED', message: error instanceof CallbackError ? error.message : 'CALLBACK_REQUEST_FAILED' });
  });
}
function injectCallbackPage(html,site) {
  if (!site.externalCallback?.page_enabled) return html;
  const tag = '<script defer src="/__ih/callback/page-client.js" data-ih-callback-site="'+encodeURIComponent(site.id)+'"></script>';
  return /<\/head>/i.test(html) ? html.replace(/<\/head>/i,tag+'</head>') : tag+html;
}
module.exports = { mountCallbackRoutes, injectCallbackPage };
