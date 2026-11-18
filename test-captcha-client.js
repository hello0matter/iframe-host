const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('./public/captcha-client.js'), 'utf8');

async function scenario({ native = false, unsupported = false, disconnected = false, failed = false, failureCode = 'CAPTCHA_HOURLY_LIMIT', wrongPage = false, nativeDuringFetch = false, config: overrides = {}, selectorInvalid = false, callbackThrows = false, resetDuringFetch = false, noCallback = false } = {}) {
  const timeouts = [];
  const requests = [];
  const diagnostics = [];
  const stored = new Map();
  const callbacks = [];
  const customCallbacks = [];
  const inputs = [];
  const notices = [];
  const noticeMessages = [];
  const errors = [];
  const expirations = [];
  let time = 1000000;
  let rendered;
  let renderCount = 0;
  let nativeResets = 0;
  const selected = { tagName: 'INPUT', type: 'hidden', name: 'custom', value: '', dispatchEvent() {} };
  const node = { isConnected: !disconnected, after: notice => notices.push(notice), querySelectorAll: () => inputs, appendChild: field => inputs.push(field) };
  const config = { debug: true, site: 'test', sitekey: 'public-test-key', page: '/demo/login', ticket: 'test-ticket', timeout: 30, ...overrides };
  const window = {
    sessionStorage: { setItem: (key, value) => stored.set(key, value) },
    console: { info() {} },
    app: { done(token) { assert.equal(this, window.app); customCallbacks.push(token); } },
    fetch: async (url, request) => {
      if (url.endsWith('/diagnostics')) {
        diagnostics.push(JSON.parse(request.body));
        return { ok: true, json: async () => ({ ok: true }) };
      }
      requests.push({ url, body: JSON.parse(request.body) });
      if (nativeDuringFetch) rendered.callback('native-result');
      if (resetDuringFetch) window.turnstile.reset('ih-provider-1');
      return { ok: !failed, json: async () => failed ? { error: failureCode } : { status: 'ready', token: 'mock-result' } };
    },
    turnstile: {
      render: (container, options) => { rendered = options; renderCount++; return 'widget-id'; },
      getResponse: () => 'unrelated-native-response',
      reset: () => nativeResets++,
    },
  };
  const document = {
    currentScript: { dataset: { captcha: Buffer.from(JSON.stringify(config)).toString('base64url') } },
    addEventListener() {},
    querySelector: value => value === '#widget' ? node : null,
    querySelectorAll: value => { if (selectorInvalid) throw new Error('bad selector'); return value === '#custom' ? [selected] : []; },
    createElement: () => ({ tagName: 'INPUT', value: '', set textContent(value) { this.text = value; noticeMessages.push(value); }, get textContent() { return this.text; }, setAttribute() {}, dispatchEvent() {}, remove() { this.removed = true; } }),
  };
  const context = { window, document, navigator: { language: 'en' }, location: { pathname: wrongPage ? '/elsewhere' : '/demo/login' }, atob: value => Buffer.from(value, 'base64').toString('binary'), setTimeout: (fn, delay) => timeouts.push({ fn, at: time + delay }), setInterval: () => 1, clearInterval() {}, Date: class extends Date { static now() { return time; } }, AbortSignal, Event, TextDecoder };
  vm.runInNewContext(source, context);
  const options = { sitekey: config.sitekey, 'expired-callback': () => expirations.push(true), 'error-callback': value => errors.push(value), ...(noCallback ? {} : { callback: token => { if (callbackThrows) throw new Error('callback failed'); callbacks.push(token); } }), ...(unsupported ? { cData: 'unsupported' } : {}) };
  const id = window.turnstile.render('#widget', options);
  assert.equal(id, config.mode === 'provider_only' && !unsupported && !wrongPage ? 'ih-provider-1' : 'widget-id');
  if (native) rendered.callback('native-result');
  async function advance(ms) {
    time += ms;
    for (let i = 0; i < 20; i++) {
      const ready = timeouts.filter(task => task.at <= time);
      for (const task of ready) { timeouts.splice(timeouts.indexOf(task), 1); task.fn(); }
      await new Promise(resolve => setImmediate(resolve));
    }
  }
  await advance(10000);
  return { noticeMessages, diagnostics, stored, requests, callbacks, customCallbacks, inputs, notices, errors, expirations, selected, id, node, api: window.turnstile, rendered, advance, renderCount, nativeResets: () => nativeResets };
}

async function main() {
  const quiet = await scenario({ config: { debug: false } });
  assert.deepEqual(quiet.diagnostics, []);
  assert.equal(quiet.stored.size, 0);
  assert.deepEqual(quiet.callbacks, ['mock-result']);
  assert.equal(quiet.requests.length, 1);
  const customized = await scenario({ config: { messages: { waiting: '正在验证，请稍候…', ready: '验证完成，可以登录啦 ✅' } } });
  assert.ok(customized.noticeMessages.includes('正在验证，请稍候…'));
  assert.ok(customized.noticeMessages.includes('验证完成，可以登录啦 ✅'));
  assert.deepEqual(customized.callbacks, ['mock-result']);
  const literal = await scenario({ config: { messages: { ready: '<img src=x onerror=alert(1)>' } } });
  assert.ok(literal.noticeMessages.includes('<img src=x onerror=alert(1)>'));
  const blank = await scenario({ config: { messages: { ready: '   ', waiting: '' } } });
  assert.ok(blank.noticeMessages.includes('Verification complete. Please click Sign in.'));
  for (const code of Object.values(require('./captcha-service').CAPTCHA_MESSAGE_FIELDS).filter(code => code.startsWith('CAPTCHA_'))) {
    const failedCustom = await scenario({ failed: true, failureCode: code, config: { messages: { [code]: '自定义错误：' + code } } });
    assert.ok(failedCustom.noticeMessages.includes('自定义错误：' + code), code);
    assert.deepEqual(failedCustom.callbacks, []);
    assert.equal(failedCustom.requests.length, 1);
    assert.equal(failedCustom.inputs.length, 0);
  }
  const expiry = await scenario({ config: { messages: { expired: '验证已过期，请重新验证' } } });
  await expiry.advance(120001);
  assert.ok(expiry.noticeMessages.includes('验证已过期，请重新验证'));
  assert.equal(expiry.inputs[0].value, '');
  assert.equal(expiry.requests.length, 1);
  const resetMessage = await scenario({ config: { messages: { reset: '请重新打开页面验证' } } });
  resetMessage.api.reset(resetMessage.id);
  assert.ok(resetMessage.noticeMessages.includes('请重新打开页面验证'));
  assert.equal(resetMessage.inputs[0].value, '');
  const fallback = await scenario({ failed: true, failureCode: 'CAPTCHA_UNKNOWN', config: { messages: { error: '未分类失败，请联系管理员' } } });
  assert.ok(fallback.noticeMessages.includes('未分类失败，请联系管理员'));
  const ready = await scenario();
  assert.equal(ready.requests.length, 1);
  assert.equal(ready.requests[0].url, '/__ih/captcha/test');
  assert.equal(ready.requests[0].body.metadata.sitekey, 'public-test-key');
  assert.deepEqual(ready.callbacks, ['mock-result']);
  const stages = ready.diagnostics.map(row => row.event);
  for (const event of ['client_loaded', 'api_wrapped', 'render_seen', 'widget_matched', 'task_requested', 'result_received', 'fields_written', 'original_callback_started', 'original_callback_done', 'ready']) assert.ok(stages.includes(event), event);
  assert.ok(stages.indexOf('result_received') < stages.indexOf('original_callback_done'));
  assert.ok(!JSON.stringify(ready.diagnostics).includes('mock-result'));
  assert.ok(!ready.stored.get('ihCaptchaDiagnostics').includes('mock-result'));
  assert.ok(!ready.stored.get('ihCaptchaDiagnostics').includes('test-ticket'));
  assert.equal(ready.inputs[0].name, 'cf-turnstile-response');
  assert.equal(ready.inputs[0].value, 'mock-result');
  assert.equal(ready.api.getResponse(ready.id), 'mock-result');
  assert.equal(ready.api.getResponse('unrelated-id'), 'unrelated-native-response');
  ready.rendered['error-callback']('native-error');
  ready.rendered['expired-callback']();
  ready.rendered['unsupported-callback']();
  ready.rendered.callback('late-native-result');
  assert.deepEqual(ready.callbacks, ['mock-result']);
  assert.equal(ready.errors.length, 0);
  assert.equal(ready.expirations.length, 0);
  await ready.advance(120001);
  assert.equal(ready.inputs[0].value, '');
  assert.equal(ready.api.getResponse(ready.id), '');
  assert.equal(ready.expirations.length, 1);
  assert.match(ready.notices[0].textContent, /expired/);
  for (const options of [{ native: true }, { unsupported: true }, { disconnected: true }, { wrongPage: true }]) assert.equal((await scenario(options)).requests.length, 0);
  assert.ok((await scenario({ wrongPage: true })).diagnostics.some(row => row.event === 'page_mismatch'));
  assert.ok((await scenario({ unsupported: true })).diagnostics.some(row => row.event === 'unsupported_widget'));
  const raced = await scenario({ nativeDuringFetch: true });
  assert.deepEqual(raced.callbacks, ['native-result']);
  assert.equal(raced.inputs.length, 0);
  const failed = await scenario({ failed: true });
  assert.equal(failed.requests.length, 1);
  assert.equal(failed.callbacks.length, 0);
  assert.match(failed.notices[0].textContent, /limit reached/);
  const forced = await scenario({ config: { mode: 'provider_only' } });
  assert.equal(forced.renderCount, 0);
  assert.equal(forced.api.getResponse(forced.id), 'mock-result');
  assert.equal(forced.api.isExpired(forced.id), false);
  forced.api.reset(forced.id);
  assert.equal(forced.api.getResponse(forced.id), '');
  assert.equal(forced.api.isExpired(forced.id), true);
  await forced.advance(180000);
  assert.equal(forced.expirations.length, 1);
  assert.equal(forced.requests.length, 1);
  assert.equal(forced.nativeResets(), 0);
  const custom = await scenario({ config: { mode: 'provider_only', responseSelector: '#custom', callbackPath: 'app.done' }, noCallback: true });
  assert.equal(custom.selected.value, 'mock-result');
  assert.deepEqual(custom.customCallbacks, ['mock-result']);
  custom.api.remove(custom.id);
  assert.equal(custom.selected.value, '');
  assert.equal(custom.notices[0].removed, true);
  const named = await scenario({ config: { responseFieldName: 'verification-token' } });
  assert.equal(named.inputs[0].name, 'verification-token');
  for (const config of [{ responseSelector: '#missing' }, { callbackPath: 'app.missing' }, { callbackPath: 'constructor.constructor' }]) assert.equal((await scenario({ config })).requests.length, 0);
  assert.equal((await scenario({ config: { responseSelector: '[' }, selectorInvalid: true })).requests.length, 0);
  const thrown = await scenario({ callbackThrows: true });
  assert.equal(thrown.inputs[0].value, '');
  assert.ok(thrown.diagnostics.some(row => row.event === 'original_callback_failed'));
  assert.ok(!thrown.diagnostics.some(row => row.event === 'ready'));
  assert.ok(failed.diagnostics.some(row => row.event === 'CAPTCHA_HOURLY_LIMIT'));
  assert.ok(!thrown.notices[0].textContent.includes('ready'));
  const cancelled = await scenario({ config: { mode: 'provider_only' }, resetDuringFetch: true });
  assert.equal(cancelled.callbacks.length, 0);
  assert.equal(cancelled.api.getResponse(cancelled.id), '');
  console.log('PASS: captcha modes, native races, real-result expiry/reset/remove, selectors/callbacks, invalid adapters and no paid retry (mock only).');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
