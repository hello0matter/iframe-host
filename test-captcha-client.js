const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('./public/captcha-client.js'), 'utf8');

async function scenario({ native = false, unsupported = false, disconnected = false, failed = false, wrongPage = false, nativeDuringFetch = false } = {}) {
  const timeouts = [];
  const requests = [];
  const callbacks = [];
  const inputs = [];
  const notices = [];
  let rendered;
  const node = { isConnected: !disconnected, after: notice => notices.push(notice), querySelectorAll: () => inputs, appendChild: field => inputs.push(field) };
  const config = { site: 'test', sitekey: 'public-test-key', page: '/demo/login', ticket: 'test-ticket', timeout: 30 };
  const window = {
    fetch: async (url, request) => {
      requests.push({ url, body: JSON.parse(request.body) });
      if (nativeDuringFetch) rendered.callback('native-result');
      return { ok: !failed, json: async () => failed ? { error: 'CAPTCHA_HOURLY_LIMIT' } : { status: 'ready', token: 'mock-result' } };
    },
    turnstile: { render: (container, options) => { rendered = options; return 'widget-id'; } },
  };
  const document = {
    currentScript: { dataset: { captcha: Buffer.from(JSON.stringify(config)).toString('base64url') } },
    addEventListener() {},
    querySelector: () => node,
    createElement: () => ({ setAttribute() {}, dispatchEvent() {}, remove() { this.removed = true; } }),
  };
  const context = { window, document, navigator: { language: 'en' }, location: { pathname: wrongPage ? '/elsewhere' : '/demo/login' }, atob: value => Buffer.from(value, 'base64').toString(), setTimeout: fn => timeouts.push(fn), setInterval: () => 1, clearInterval() {}, Date, AbortSignal, Event };
  vm.runInNewContext(source, context);
  const options = { sitekey: config.sitekey, callback: token => callbacks.push(token), ...(unsupported ? { cData: 'unsupported' } : {}) };
  assert.equal(window.turnstile.render('#widget', options), 'widget-id');
  if (native) rendered.callback('native-result');
  for (const timeout of timeouts) timeout();
  for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
  return { requests, callbacks, inputs, notices };
}

async function main() {
  const ready = await scenario();
  assert.equal(ready.requests.length, 1);
  assert.equal(ready.requests[0].url, '/__ih/captcha/test');
  assert.equal(ready.requests[0].body.metadata.sitekey, 'public-test-key');
  assert.deepEqual(ready.callbacks, ['mock-result']);
  assert.equal(ready.inputs[0].name, 'cf-turnstile-response');
  assert.equal(ready.inputs[0].value, 'mock-result');
  for (const options of [{ native: true }, { unsupported: true }, { disconnected: true }, { wrongPage: true }]) {
    assert.equal((await scenario(options)).requests.length, 0);
  }
  const raced = await scenario({ nativeDuringFetch: true });
  assert.deepEqual(raced.callbacks, ['native-result']);
  assert.equal(raced.inputs.length, 0);
  const failed = await scenario({ failed: true });
  assert.equal(failed.requests.length, 1);
  assert.equal(failed.callbacks.length, 0);
  assert.match(failed.notices[0].textContent, /limit reached/);
  console.log('PASS: captcha client callback, response field, native-first race, unsupported widgets, page matching and no paid retry (mock only).');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
