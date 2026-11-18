const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeCaptcha, createCaptchaService, injectCaptcha } = require('./captcha-service');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ih-captcha-test-'));
const key = 'unit-test-placeholder-not-a-real-api-key';
const baseTime = Date.now();
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(name, options = {}) {
  let time = baseTime;
  const calls = [];
  const logs = [];
  const stateFile = path.join(tmp, name + '.json');
  const site = { id: name, enabled: true, targetBase: 'https://upstream.example', proxyPrefix: '/demo', captcha: normalizeCaptcha({ enabled: true, site_key: 'public-test-sitekey', max_tasks_per_hour: 2 }) };
  const service = createCaptchaService({
    stateFile, env: { CAPTCHA_2CAPTCHA_API_KEY: key }, now: () => time,
    sleep: async ms => { time += ms; await tick(); }, log: value => logs.push(value),
    fetchImpl: async (url, request) => {
      calls.push({ url, body: JSON.parse(request.body) });
      return { ok: true, json: async () => url.endsWith('/createTask') ? { errorId: 0, taskId: 123 } : { errorId: 0, status: 'ready', solution: { token: 'unit-test-solution' } } };
    }, ...options,
  });
  const req = { headers: { 'x-forwarded-proto': 'https' } };
  const headers = {};
  const ticket = service.issue(site, req, headers);
  req.headers.cookie = headers['set-cookie'][0].split(';')[0];
  const metadata = { sitekey: site.captcha.site_key, action: 'login' };
  return { service, stateFile, site, req, ticket, metadata, calls, logs, advance: ms => { time += ms; } };
}

function rejects(fn, code) { assert.throws(fn, error => error.code === code); }

async function main() {
  assert.equal(normalizeCaptcha().enabled, false);
  assert.equal(normalizeCaptcha().max_tasks_per_hour, 3);
  for (const limit of [1, 20, 21, 100]) {
    assert.equal(normalizeCaptcha({ max_tasks_per_hour: limit }).max_tasks_per_hour, limit);
  }
  for (const limit of [0, -1, 101, 1.5, 'invalid', '']) {
    assert.throws(() => normalizeCaptcha({ max_tasks_per_hour: limit }), /hourly limit must be 1-100/);
  }
  assert.equal(normalizeCaptcha().mode, 'native_first');
  assert.equal(normalizeCaptcha().result_ttl_seconds, 120);
  for (const raw of [{ mode: 'force-button' }, { response_selector: [] }, { response_selector: '\n' }, { response_field_name: 'invalid name' }, { callback_path: 'alert(token)' }, { callback_path: 'app.__proto__.callback' }, { callback_path: 'constructor.constructor' }, { result_ttl_seconds: 999 }]) assert.throws(() => normalizeCaptcha(raw));
  const advanced = normalizeCaptcha({ mode: 'provider_only', response_selector: '#my-token', response_field_name: 'my-token', callback_path: 'app.verified', result_ttl_seconds: 60 });
  const injected = injectCaptcha('<head></head>', { id: 'advanced', proxyPrefix: '/test', captcha: advanced }, 'test-ticket');
  const config = JSON.parse(Buffer.from(injected.match(/data-captcha="([^"]+)"/)[1], 'base64url').toString());
  assert.equal(config.mode, 'provider_only');
  assert.equal(config.responseSelector, '#my-token');
  assert.equal(config.callbackPath, 'app.verified');
  assert.equal(config.resultTtl, 60);
  for (const raw of [null, [], { enabled: true }, { provider: 'other' }, { api_key_env: 'secret-value-with-hyphens' }, { timeout_seconds: 500 }, { max_tasks_per_hour: 0 }, { page_path: '//elsewhere/' }, { page_path: '/../login' }]) {
    assert.throws(() => normalizeCaptcha(raw));
  }
  const diagnostic = fixture('diagnostic');
  assert.equal(diagnostic.service.status(diagnostic.site).enabled, true);
  assert.equal(diagnostic.service.status(diagnostic.site).recent_events.length, 0);
  rejects(() => diagnostic.service.report(diagnostic.site, { headers: {} }, { ticket: diagnostic.ticket, event: 'client_loaded' }), 'CAPTCHA_TICKET_INVALID');
  rejects(() => diagnostic.service.report(diagnostic.site, diagnostic.req, { ticket: diagnostic.ticket, event: 'secret-from-client' }), 'CAPTCHA_DIAGNOSTIC_INVALID');
  for (let i = 0; i < 48; i++) diagnostic.service.report(diagnostic.site, diagnostic.req, { ticket: diagnostic.ticket, event: 'client_loaded', password: 'do-not-log-me' });
  rejects(() => diagnostic.service.report(diagnostic.site, diagnostic.req, { ticket: diagnostic.ticket, event: 'ready' }), 'CAPTCHA_DIAGNOSTIC_LIMIT');
  const events = diagnostic.service.status(diagnostic.site).recent_events;
  assert.equal(events.length, 48);
  assert.equal(events[0].source, 'browser');
  assert.match(events[0].page, /^[a-f0-9]{12}$/);
  assert.ok(!JSON.stringify(events).includes(diagnostic.ticket));
  assert.ok(!diagnostic.logs.join('').includes('do-not-log-me'));
  assert.equal(diagnostic.calls.length, 0);
  assert.equal(diagnostic.service.status(diagnostic.site).tasks_this_hour, 0);
  diagnostic.advance(300001);
  rejects(() => diagnostic.service.report(diagnostic.site, diagnostic.req, { ticket: diagnostic.ticket, event: 'ready' }), 'CAPTCHA_TICKET_INVALID');
  const f = fixture('normal');
  const body = { ticket: f.ticket, metadata: f.metadata };
  const markup = injectCaptcha('<html><head><script src="/app.js"></script></head></html>', f.site, f.ticket);
  assert.ok(markup.indexOf('/__ih/captcha/client.js') < markup.indexOf('/app.js'));
  assert.ok(!markup.includes(key));
  assert.equal(injectCaptcha('unchanged', f.site, null), 'unchanged');
  rejects(() => f.service.request(f.site, { headers: {} }, body), 'CAPTCHA_TICKET_INVALID');
  rejects(() => f.service.request(f.site, f.req, { ...body, ticket: f.ticket + 'x' }), 'CAPTCHA_TICKET_INVALID');
  rejects(() => f.service.request({ ...f.site, id: 'another' }, f.req, body), 'CAPTCHA_TICKET_INVALID');
  rejects(() => f.service.request(f.site, f.req, { ...body, metadata: { ...f.metadata, cData: 'not-supported' } }), 'CAPTCHA_WIDGET_UNSUPPORTED');
  assert.equal(f.service.request(f.site, f.req, body).status, 'processing');
  assert.equal(f.service.request(f.site, f.req, body).status, 'processing');
  const second = f.service.issue(f.site, f.req, {});
  rejects(() => f.service.request(f.site, f.req, { ...body, ticket: second }), 'CAPTCHA_BUSY');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, 'https://api.2captcha.com/createTask');
  assert.deepEqual(f.calls[0].body.task, { type: 'TurnstileTaskProxyless', websiteURL: 'https://upstream.example/login', websiteKey: 'public-test-sitekey', action: 'login' });
  for (let i = 0; i < 20 && f.service.status(f.site).active; i++) await tick();
  assert.deepEqual(f.service.request(f.site, f.req, body), { status: 'ready', token: 'unit-test-solution' });
  assert.equal(f.service.status(f.site).tasks_this_hour, 1);
  f.service.request(f.site, f.req, { ...body, ticket: second });
  for (let i = 0; i < 20 && f.service.status(f.site).active; i++) await tick();
  rejects(() => f.service.request(f.site, f.req, { ...body, ticket: f.service.issue(f.site, f.req, {}) }), 'CAPTCHA_HOURLY_LIMIT');
  assert.equal(f.calls.filter(call => call.url.endsWith('/createTask')).length, 2);
  const persisted = fs.readFileSync(f.stateFile, 'utf8');
  assert.ok(!persisted.includes(key) && !persisted.includes('unit-test-solution'));
  assert.ok(!f.logs.join('').includes(key) && !f.logs.join('').includes('unit-test-solution'));
  const restarted = createCaptchaService({ stateFile: f.stateFile, env: { CAPTCHA_2CAPTCHA_API_KEY: key }, now: () => baseTime });
  assert.equal(restarted.status(f.site).tasks_this_hour, 2);
  rejects(() => restarted.request(f.site, f.req, { ticket: restarted.issue(f.site, f.req, {}), metadata: f.metadata }), 'CAPTCHA_HOURLY_LIMIT');
  f.advance(3600000);
  assert.equal(f.service.status(f.site).tasks_this_hour, 0);
  rejects(() => f.service.request(f.site, f.req, body), 'CAPTCHA_TICKET_INVALID');

  const missing = fixture('missing', { env: {} });
  rejects(() => missing.service.request(missing.site, missing.req, { ticket: missing.ticket, metadata: missing.metadata }), 'CAPTCHA_KEY_MISSING');
  assert.equal(missing.calls.length, 0);
  assert.equal(missing.service.status(missing.site).tasks_this_hour, 0);
  rejects(() => missing.service.request({ ...missing.site, captcha: normalizeCaptcha() }, missing.req, {}), 'CAPTCHA_DISABLED');

  const failed = fixture('failed', { fetchImpl: async () => { throw new Error(key); } });
  const failedBody = { ticket: failed.ticket, metadata: failed.metadata };
  failed.service.request(failed.site, failed.req, failedBody);
  for (let i = 0; i < 10; i++) await tick();
  assert.deepEqual(failed.service.request(failed.site, failed.req, failedBody), { status: 'failed', error: 'CAPTCHA_PROVIDER_UNAVAILABLE' });
  assert.equal(failed.service.status(failed.site).tasks_this_hour, 1);
  assert.ok(!failed.logs.join('').includes(key));

  const brokenFile = path.join(tmp, 'broken.json');
  fs.writeFileSync(brokenFile, '{broken');
  const broken = fixture('broken');
  rejects(() => broken.service.request(broken.site, broken.req, { ticket: broken.ticket, metadata: broken.metadata }), 'CAPTCHA_BUDGET_STORAGE_ERROR');
  assert.equal(broken.calls.length, 0);
  const blocked = fixture('blocked');
  fs.mkdirSync(blocked.stateFile + '.new');
  rejects(() => blocked.service.request(blocked.site, blocked.req, { ticket: blocked.ticket, metadata: blocked.metadata }), 'CAPTCHA_BUDGET_STORAGE_ERROR');
  assert.equal(blocked.calls.length, 0);
  console.log('PASS: captcha mock provider, ticket binding, deduplication, persistent quotas, missing secrets, redaction and fail-closed storage. No paid API was called.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
