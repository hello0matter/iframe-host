(function () {
  'use strict';
  var script = document.currentScript;
  if (!script || !script.dataset.captcha || window.__ihCaptchaInstalled) return;
  var config;
  try { config = JSON.parse(atob(script.dataset.captcha.replace(/-/g, '+').replace(/_/g, '/'))); } catch (_) { return; }
  window.__ihCaptchaInstalled = true;
  var fetchRequest = window.fetch.bind(window);
  var diagnosticEvents = [];
  var diagnosticSeen = new Set();
  function trace(event) {
    if (diagnosticSeen.has(event) || diagnosticEvents.length >= 40) return;
    diagnosticSeen.add(event);
    var row = { at: new Date().toISOString(), event: event };
    diagnosticEvents.push(row);
    window.__ihCaptchaDiagnostics = diagnosticEvents.map(function (item) { return { at: item.at, event: item.event }; });
    try { window.sessionStorage.setItem('ihCaptchaDiagnostics', JSON.stringify(diagnosticEvents)); } catch (_) {}
    try { window.console.info('[captcha]', event); } catch (_) {}
    try {
      void fetchRequest('/__ih/captcha/' + encodeURIComponent(config.site) + '/diagnostics', {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ticket: config.ticket, event: event }), signal: AbortSignal.timeout(5000),
      }).catch(function () {});
    } catch (_) {}
  }
  trace('client_loaded');
  var used = false;
  var expires = Date.now() + 290000;
  var widgets = new Map();
  var sequence = 0;
  var isChinese = /^zh/i.test(navigator.language || '');
  function message(node, code) {
    var zh = { waiting: '正在等待验证码服务，可能产生费用…', ready: '验证成功，请点击登录。', expired: '验证码结果已失效，请刷新后重新验证；不会自动重试扣费。', reset: '验证码已重置；本页不会再次自动付费，请刷新后重新验证。', CAPTCHA_ADAPTER_INVALID: '验证码适配参数无效：请检查字段选择器和全局回调。', CAPTCHA_KEY_MISSING: '服务器尚未配置验证码服务密钥。', CAPTCHA_HOURLY_LIMIT: '本站本小时验证码调用已达上限。', CAPTCHA_BUSY: '验证码服务忙，请稍后重新打开页面。', CAPTCHA_TIMEOUT: '验证码服务超时；不会自动重试扣费。', CAPTCHA_TICKET_INVALID: '验证码会话已过期，请刷新页面。' };
    var en = { waiting: 'Waiting for verification service; charges may apply…', ready: 'Verification complete. Please click Sign in.', expired: 'Verification result expired. Reload to verify again; no automatic paid retry.', reset: 'Verification reset. No further automatic paid task on this page; reload to verify again.', CAPTCHA_ADAPTER_INVALID: 'Invalid verification adapter: check the field selector and global callback.', CAPTCHA_KEY_MISSING: 'Verification service key is not configured.', CAPTCHA_HOURLY_LIMIT: 'Hourly verification task limit reached.', CAPTCHA_BUSY: 'Verification service is busy. Reopen this page later.', CAPTCHA_TIMEOUT: 'Verification timed out. No automatic paid retry.', CAPTCHA_TICKET_INVALID: 'Verification session expired. Refresh this page.' };
    node.textContent = (isChinese ? zh : en)[code] || (isChinese ? '验证码服务失败，请刷新后手动验证，或联系管理员。' : 'Verification service failed. Reload for manual verification or contact the administrator.');
  }
  function callback(value) {
    if (typeof value === 'function') return { fn: value, owner: window };
    if (typeof value !== 'string' || !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(value)) return null;
    var parts = value.split('.');
    if (parts.some(function (key) { return ['__proto__', 'prototype', 'constructor'].includes(key); })) return null;
    var owner = window;
    for (var i = 0; i < parts.length - 1; i++) { owner = owner && owner[parts[i]]; }
    var fn = owner && owner[parts[parts.length - 1]];
    return typeof fn === 'function' ? { fn: fn, owner: owner } : null;
  }
  function invoke(value, token) {
    var cb = callback(value);
    if (cb) return cb.fn.call(cb.owner, token);
  }
  function alive(state) { return !state.stopped && state.node.isConnected; }
  function valid(state) { return alive(state) && !!state.token && Date.now() < state.until; }
  function fields(state) {
    if (config.responseSelector) {
      var selected = Array.from(document.querySelectorAll(config.responseSelector));
      if (!selected.length || selected.some(function (field) { return !/^(INPUT|TEXTAREA)$/.test(field.tagName) || (field.tagName === 'INPUT' && !['hidden', 'text'].includes(field.type)); })) throw new Error('CAPTCHA_ADAPTER_INVALID');
      return selected;
    }
    if (state.options['response-field'] === false && !config.responseFieldName) return [];
    var name = config.responseFieldName || state.options['response-field-name'] || 'cf-turnstile-response';
    var field = Array.from(state.node.querySelectorAll('input')).find(function (item) { return item.name === name; });
    if (!field) { field = document.createElement('input'); field.type = 'hidden'; field.name = name; state.node.appendChild(field); }
    return [field];
  }
  function write(field, value) {
    field.value = value;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function invalidate(state, reason, notify) {
    if (state.stopped) return;
    state.stopped = true;
    trace(reason === 'expired' ? 'expired' : reason === 'reset' ? 'reset' : 'service_failed');
    var token = state.token;
    state.token = '';
    (state.fields || []).forEach(function (field) { if (field.value === token) write(field, ''); });
    if (state.notice) message(state.notice, reason);
    if (notify) { try { invoke(state.options['expired-callback']); } catch (_) {} }
  }
  async function solve(state) {
    if (used || state.nativeReady || !alive(state)) return;
    used = true;
    var options = state.options;
    var notice = document.createElement('p');
    notice.setAttribute('role', 'status');
    state.node.after(notice);
    state.notice = notice;
    message(notice, 'waiting');
    var deadline = Date.now() + (config.timeout + 15) * 1000;
    try {
      if (config.callbackPath && !callback(config.callbackPath)) throw new Error('CAPTCHA_ADAPTER_INVALID');
      if (config.responseSelector) fields(state);
      trace('task_requested');
      while (Date.now() < deadline && alive(state) && !state.nativeReady) {
        var response = await fetchRequest('/__ih/captcha/' + encodeURIComponent(config.site), {
          method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ticket: config.ticket, metadata: { sitekey: options.sitekey, action: options.action || '' } }),
          signal: AbortSignal.timeout(15000),
        });
        var result = await response.json();
        if (!response.ok || result.status === 'failed') throw new Error(result.error || 'CAPTCHA_PROVIDER_UNAVAILABLE');
        if (!alive(state) || state.nativeReady) return;
        if (result.status === 'processing') trace('task_processing');
        if (result.status === 'ready') {
          trace('result_received');
          if (typeof result.token !== 'string' || !result.token) throw new Error('CAPTCHA_PROVIDER_BAD_RESPONSE');
          state.fields = fields(state);
          state.token = result.token;
          state.providerIssued = true;
          state.until = Date.now() + Math.max(30, Math.min(240, Number(config.resultTtl) || 120)) * 1000;
          state.fields.forEach(function (field) { write(field, result.token); });
          if (state.fields.length) trace('fields_written');
          if (callback(options.callback)) {
            trace('original_callback_started');
            try { invoke(options.callback, result.token); trace('original_callback_done'); }
            catch (_) { trace('original_callback_failed'); throw new Error('CAPTCHA_CALLBACK_FAILED'); }
          }
          if (config.callbackPath && config.callbackPath !== options.callback) {
            trace('extra_callback_started');
            try { if (!callback(config.callbackPath)) throw new Error('callback unavailable'); invoke(config.callbackPath, result.token); trace('extra_callback_done'); }
            catch (_) { trace('extra_callback_failed'); throw new Error('CAPTCHA_CALLBACK_FAILED'); }
          }
          if (!valid(state)) return;
          message(notice, 'ready');
          trace('ready');
          setTimeout(function () { invalidate(state, 'expired', true); }, Math.max(0, state.until - Date.now()));
          return;
        }
        await new Promise(function (resolve) { setTimeout(resolve, 2000); });
      }
      if (!state.nativeReady && alive(state)) throw new Error('CAPTCHA_TIMEOUT');
    } catch (error) {
      if (["CAPTCHA_KEY_MISSING", "CAPTCHA_HOURLY_LIMIT", "CAPTCHA_BUSY", "CAPTCHA_TIMEOUT", "CAPTCHA_TICKET_INVALID", "CAPTCHA_ADAPTER_INVALID", "CAPTCHA_CALLBACK_FAILED", "CAPTCHA_PROVIDER_REJECTED", "CAPTCHA_PROVIDER_UNAVAILABLE", "CAPTCHA_PROVIDER_BAD_RESPONSE", "CAPTCHA_BUDGET_STORAGE_ERROR", "CAPTCHA_DISABLED"].includes(error.message)) trace(error.message);
      invalidate(state, error.message, !!state.token);
      try { invoke(options['error-callback'], 'IH_SERVICE_FAILED'); } catch (_) {}
    } finally { if (state.nativeReady || !state.node.isConnected) notice.remove(); }
  }
  function wrap() {
    var api = window.turnstile;
    if (!api || typeof api.render !== 'function' || api.render.__ihWrapped) return;
    var render = api.render;
    trace('api_wrapped');
    function find(value) {
      if (widgets.has(value)) return widgets.get(value);
      var node;
      try { node = typeof value === 'string' ? document.querySelector(value) : value; } catch (_) {}
      for (var state of widgets.values()) if (value == null || state.node === node) return state;
      return null;
    }
    ['getResponse', 'isExpired', 'reset', 'remove', 'execute'].forEach(function (name) {
      var original = api[name];
      api[name] = function (id) {
        var state = find(id);
        if (state) {
          if (name === 'getResponse' && (state.virtual || state.providerIssued)) return valid(state) ? state.token : '';
          if (name === 'isExpired' && (state.virtual || state.providerIssued)) return !valid(state);
          if (name === 'reset' || name === 'remove') {
            invalidate(state, 'reset', name === 'reset');
            if (name === 'remove') { if (state.notice) state.notice.remove(); widgets.delete(state.id); }
          }
          if (state.virtual) return;
        }
        if (typeof original === 'function') return original.apply(this, arguments);
      };
    });
    function wrapped(container, options) {
      trace('render_seen');
      var node;
      try { node = typeof container === 'string' ? document.querySelector(container) : container; } catch (_) { return render.apply(this, arguments); }
      var eligible = options && options.sitekey === config.sitekey && (callback(options.callback) || callback(config.callbackPath) || config.responseSelector || config.responseFieldName) && !options.cData && !options.chlPageData && location.pathname.replace(/\/+$/, '') === config.page.replace(/\/+$/, '') && Date.now() < expires;
      if (!eligible || !node) {
        trace(!node ? 'container_missing' : !options || options.sitekey !== config.sitekey ? 'sitekey_mismatch' : location.pathname.replace(/\/+$/, '') !== config.page.replace(/\/+$/, '') ? 'page_mismatch' : options.cData || options.chlPageData ? 'unsupported_widget' : Date.now() >= expires ? 'ticket_expired' : 'callback_missing');
        return render.apply(this, arguments);
      }
      trace('widget_matched');
      var state = { node: node, options: options, nativeReady: false, token: '', until: 0, stopped: false, virtual: config.mode === 'provider_only' };
      var next = Object.assign({}, options, { callback: function (token) { if (valid(state) || state.stopped) return; state.nativeReady = true; trace('native_success'); return invoke(options.callback, token); } });
      ['error-callback', 'expired-callback', 'timeout-callback', 'unsupported-callback'].forEach(function (name) {
        next[name] = function (value) { if (!valid(state) && !state.stopped) return invoke(options[name], value); };
      });
      state.id = state.virtual ? 'ih-provider-' + (++sequence) : render.call(this, container, next);
      widgets.set(state.id, state);
      setTimeout(function () { void solve(state); }, state.virtual ? 0 : 10000);
      return state.id;
    }
    wrapped.__ihWrapped = true;
    api.render = wrapped;
  }
  document.addEventListener('load', function (event) {
    if (event.target.tagName === 'SCRIPT' && /^https:\/\/challenges\.cloudflare\.com\/turnstile\//.test(event.target.src || '')) wrap();
  }, true);
  var timer = setInterval(function () {
    widgets.forEach(function (state, id) {
      if (!state.node.isConnected) { invalidate(state, 'reset', false); widgets.delete(id); }
      else if (state.token && Date.now() >= state.until) invalidate(state, 'expired', true);
    });
    wrap();
    if (Date.now() > expires && !Array.from(widgets.values()).some(function (state) { return !state.stopped && state.token; })) clearInterval(timer);
  }, 100);
  wrap();
  setTimeout(function () { if (!window.turnstile || typeof window.turnstile.render !== 'function') trace('api_missing'); }, 10000);
})();
