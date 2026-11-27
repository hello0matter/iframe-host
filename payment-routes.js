const express = require('express');
const path = require('node:path');
const crypto = require('node:crypto');
const { PaymentError } = require('./payment-service');

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

function getPath(value, key) {
  if (!key) return undefined;
  let current = value;
  for (const part of String(key).split('.')) {
    if (!current || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, part)) return undefined;
    current = current[part];
  }
  return current;
}

function captureMatches(site, method, requestUrl) {
  if (String(method || '').toUpperCase() !== 'POST') return false;
  let pathname = '';
  try { pathname = new URL(requestUrl, site.targetBase).pathname; } catch { return false; }
  if (site.proxyPrefix && (pathname === site.proxyPrefix || pathname.startsWith(site.proxyPrefix + '/'))) {
    pathname = pathname.slice(site.proxyPrefix.length) || '/';
  }
  const config = site.payment;
  if (config.capture_match_mode === 'literal') return pathname.includes(config.capture_url_pattern);
  try { return new RegExp(config.capture_url_pattern).test(pathname); } catch { return false; }
}

function injectPaymentCapture(html, site) {
  if (!site.payment?.enabled || !site.payment?.capture_enabled) return html;
  const fields = JSON.stringify(site.payment.field_map || {});
  const tag = '<script defer src="/__ih/payment/capture.js" data-ih-payment-site="' + encodeURIComponent(site.id) +
    '" data-ih-payment-pattern="' + encodeURIComponent(site.payment.capture_url_pattern) +
    '" data-ih-payment-mode="' + encodeURIComponent(site.payment.capture_match_mode) +
    '" data-ih-payment-fields="' + encodeURIComponent(fields) + '"></script>';
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, tag + '</body>') : html + tag;
}

function mountPaymentRoutes(app, { service, adminBase, ensureAuth, getSites }) {
  const rate = new Map();
  function allowed(key, limit) {
    const timestamp = Date.now();
    const row = rate.get(key);
    if (!row || timestamp - row.start > 60000) {
      rate.set(key, { start: timestamp, count: 1 });
      return true;
    }
    row.count += 1;
    return row.count <= limit;
  }
  function deviceAuth(req, res, next) {
    const supplied = req.get('x-ih-device-token') || String(req.get('authorization') || '').replace(/^Bearer /i, '');
    const task = req.body?.task_id ? service.getTask(String(req.body.task_id)) : null;
    const siteId = String(req.query.site_id || req.body?.site_id || task?.site_id || '').trim();
    const expected = siteId ? service.tokenForSite(siteId) : (process.env.IH_DEVICE_AGENT_TOKEN || '');
    if (!expected) return res.status(503).json({ error: 'PAYMENT_DEVICE_TOKEN_NOT_CONFIGURED' });
    if (!safeEqual(supplied, expected)) return res.status(401).json({ error: 'PAYMENT_DEVICE_UNAUTHORIZED' });
    next();
  }
  app.get('/__ih/payment/capture.js', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(path.join(__dirname, 'public', 'payment-capture.js'));
  });
  app.post('/__ih/payment/capture/:siteId', express.json({ limit: '32kb', strict: true }), (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!allowed('payment-capture-global', 120) || !allowed('payment-capture:' + req.params.siteId, 60)) return res.status(429).json({ error: 'PAYMENT_CAPTURE_RATE_LIMIT' });
    let origin;
    try { origin = new URL(req.get('origin')); } catch { return res.status(403).json({ error: 'PAYMENT_CAPTURE_ORIGIN_REQUIRED' }); }
    if (origin.host !== req.get('host') || (req.get('sec-fetch-site') && req.get('sec-fetch-site') !== 'same-origin')) return res.status(403).json({ error: 'PAYMENT_CAPTURE_ORIGIN_INVALID' });
    const site = getSites().find(candidate => candidate.id === req.params.siteId && candidate.enabled);
    if (!site || !site.payment?.enabled || !site.payment?.capture_enabled) return res.status(404).json({ error: 'PAYMENT_CAPTURE_DISABLED' });
    if (!captureMatches(site, req.body?.method, req.body?.url)) return res.status(422).json({ error: 'PAYMENT_CAPTURE_IGNORED' });
    const response = req.body?.response;
    if (!response || typeof response !== 'object' || Array.isArray(response)) return res.status(422).json({ error: 'PAYMENT_CAPTURE_INVALID' });
    const map = site.payment.field_map;
    const pick = key => getPath(response, key) ?? getPath(response, 'data.' + key);
    try {
      const result = service.createIntent(site.id, {
        adapter: site.payment.adapter,
        order_ref: pick(map.order_ref),
        amount: pick(map.amount),
        qr_content: pick(map.qr_content),
        expires_at: pick(map.expires_at),
        channel: pick(map.channel),
        currency: pick(map.currency),
      }, { source: 'browser_capture' });
      res.status(201).json({ ok: true, data: { intent_id: result.intent.id, status: result.intent.status, duplicate: result.duplicate } });
    } catch (error) {
      if (error instanceof PaymentError) return res.status(422).json({ error: error.code });
      res.status(422).json({ error: 'PAYMENT_CAPTURE_IGNORED' });
    }
  });
  app.post('/__ih/payment/device/register', express.json({ limit: '16kb' }), deviceAuth, (req, res) => {
    try { res.status(201).json({ ok: true, data: service.registerDevice(req.body) }); }
    catch (error) { res.status(error instanceof PaymentError ? error.status : 400).json({ error: error.code || error.message }); }
  });
  app.get('/__ih/payment/device/next', deviceAuth, (req, res) => {
    try {
      const task = service.nextTask(String(req.query.device_id || ''));
      if (!task) return res.status(204).end();
      res.json({ ok: true, data: task });
    } catch (error) { res.status(error instanceof PaymentError ? error.status : 400).json({ error: error.code || error.message }); }
  });
  app.post('/__ih/payment/device/result', express.json({ limit: '32kb' }), deviceAuth, (req, res) => {
    try { res.json({ ok: true, data: service.deviceResult(req.body) }); }
    catch (error) { res.status(error instanceof PaymentError ? error.status : 400).json({ error: error.code || error.message }); }
  });

  const router = express.Router();
  router.use(ensureAuth, express.json({ limit: '128kb' }));
  router.get('/', (req, res) => res.json({ ok: true, summary: service.summary(), intents: service.listIntents(req.query.site_id, req.query.limit), devices: service.devices() }));
  router.post('/intents', (req, res) => {
    try { res.status(201).json({ ok: true, data: service.createIntent(req.body?.site_id, req.body, { source: 'admin' }) }); }
    catch (error) { res.status(error instanceof PaymentError ? error.status : 400).json({ ok: false, message: error.code || error.message }); }
  });
  router.get('/intents/:id', (req, res) => {
    try { res.json({ ok: true, data: service.getIntent(req.params.id) }); }
    catch (error) { res.status(error instanceof PaymentError ? error.status : 404).json({ ok: false, message: error.code || error.message }); }
  });
  router.post('/intents/:id/dispatch', (req, res) => {
    try { res.json({ ok: true, data: service.dispatchIntent(req.params.id, req.body) }); }
    catch (error) { res.status(error instanceof PaymentError ? error.status : 400).json({ ok: false, message: error.code || error.message }); }
  });
  router.post('/intents/:id/settle', (req, res) => {
    try { res.json({ ok: true, data: service.settleIntent(req.params.id, req.body) }); }
    catch (error) { res.status(error instanceof PaymentError ? error.status : 400).json({ ok: false, message: error.code || error.message }); }
  });
  router.post('/intents/:id/fulfill', (req, res) => {
    try { res.json({ ok: true, data: service.fulfillIntent(req.params.id, req.body) }); }
    catch (error) { res.status(error instanceof PaymentError ? error.status : 400).json({ ok: false, message: error.code || error.message }); }
  });
  router.post('/intents/:id/cancel', (req, res) => {
    try { res.json({ ok: true, data: service.cancelIntent(req.params.id) }); }
    catch (error) { res.status(error instanceof PaymentError ? error.status : 400).json({ ok: false, message: error.code || error.message }); }
  });
  router.get('/devices', (req, res) => res.json({ ok: true, data: service.devices() }));
  app.use(adminBase + '/api/payments', router);
  app.use((error, req, res, next) => {
    if (!req.path.startsWith('/__ih/payment/') && !req.path.startsWith(adminBase + '/api/payments')) return next(error);
    const status = error instanceof PaymentError ? error.status : error.type === 'entity.too.large' ? 413 : error instanceof SyntaxError ? 400 : 500;
    res.status(status).json({ ok: false, error: error instanceof PaymentError ? error.code : status === 413 ? 'PAYMENT_DATA_TOO_LARGE' : 'PAYMENT_REQUEST_FAILED' });
  });
}

module.exports = { mountPaymentRoutes, injectPaymentCapture, captureMatches };
