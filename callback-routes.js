const express = require('express');
const path = require('node:path');
const { CallbackError } = require('./callback-service');

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
  function rateAllowed(bucket,limit) {
    const minute=Math.floor(Date.now()/60000);
    for(const [k,v] of rate) if(v.minute!==minute) rate.delete(k);
    const entry=rate.get(bucket)||{minute,count:0};
    entry.count++;rate.set(bucket,entry);return entry.count<=limit;
  }
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
module.exports = { mountCallbackRoutes };
