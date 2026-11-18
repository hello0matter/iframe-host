(function () {
  'use strict';
  var script = document.currentScript;
  if (!script || !script.dataset.captcha || window.__ihCaptchaInstalled) return;
  var config;
  try { config = JSON.parse(atob(script.dataset.captcha.replace(/-/g, '+').replace(/_/g, '/'))); } catch (_) { return; }
  window.__ihCaptchaInstalled = true;
  var fetchRequest = window.fetch.bind(window);
  var used = false;
  var expires = Date.now() + 290000;
  var isChinese = /^zh/i.test(navigator.language || '');
  function message(node, code) {
    var zh = { waiting: '正在等待验证码服务，可能产生费用…', ready: '验证码已准备，请尽快登录。', CAPTCHA_KEY_MISSING: '服务器尚未配置验证码服务密钥。', CAPTCHA_HOURLY_LIMIT: '本站本小时验证码调用已达上限。', CAPTCHA_BUSY: '验证码服务忙，请稍后重新打开页面。', CAPTCHA_TIMEOUT: '验证码服务超时；不会自动重试扣费。', CAPTCHA_TICKET_INVALID: '验证码会话已过期，请刷新页面。' };
    var en = { waiting: 'Waiting for verification service; charges may apply…', ready: 'Verification is ready. Please sign in promptly.', CAPTCHA_KEY_MISSING: 'Verification service key is not configured.', CAPTCHA_HOURLY_LIMIT: 'Hourly verification task limit reached.', CAPTCHA_BUSY: 'Verification service is busy. Reopen this page later.', CAPTCHA_TIMEOUT: 'Verification timed out. No automatic paid retry.', CAPTCHA_TICKET_INVALID: 'Verification session expired. Refresh this page.' };
    node.textContent = (isChinese ? zh : en)[code] || (isChinese ? '验证码服务失败，请刷新后手动验证，或联系管理员。' : 'Verification service failed. Reload for manual verification or contact the administrator.');
  }
  async function solve(container, options, nativeState) {
    if (used || nativeState.ready || !container.isConnected) return;
    used = true;
    var notice = document.createElement('p');
    notice.setAttribute('role', 'status');
    container.after(notice);
    message(notice, 'waiting');
    var deadline = Date.now() + (config.timeout + 15) * 1000;
    try {
      while (Date.now() < deadline && container.isConnected && !nativeState.ready) {
        var response = await fetchRequest('/__ih/captcha/' + encodeURIComponent(config.site), {
          method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ticket: config.ticket, metadata: { sitekey: options.sitekey, action: options.action || '' } }),
          signal: AbortSignal.timeout(15000),
        });
        var result = await response.json();
        if (!response.ok || result.status === 'failed') throw new Error(result.error || 'CAPTCHA_PROVIDER_UNAVAILABLE');
        if (!container.isConnected || nativeState.ready) return;
        if (result.status === 'ready') {
          if (typeof result.token !== 'string' || !result.token) throw new Error('CAPTCHA_PROVIDER_BAD_RESPONSE');
          if (options['response-field'] !== false) {
            var name = options['response-field-name'] || 'cf-turnstile-response';
            var field = Array.from(container.querySelectorAll('input')).find(function (item) { return item.name === name; });
            if (!field) { field = document.createElement('input'); field.type = 'hidden'; field.name = name; container.appendChild(field); }
            field.value = result.token;
            field.dispatchEvent(new Event('input', { bubbles: true }));
            field.dispatchEvent(new Event('change', { bubbles: true }));
          }
          options.callback(result.token);
          message(notice, 'ready');
          return;
        }
        await new Promise(function (resolve) { setTimeout(resolve, 2000); });
      }
      if (!nativeState.ready) throw new Error('CAPTCHA_TIMEOUT');
    } catch (error) { message(notice, error.message); }
    finally { if (nativeState.ready || !container.isConnected) notice.remove(); }
  }
  function wrap() {
    var api = window.turnstile;
    if (!api || typeof api.render !== 'function' || api.render.__ihWrapped) return;
    var render = api.render;
    function wrapped(container, options) {
      var node = typeof container === 'string' ? document.querySelector(container) : container;
      var eligible = options && options.sitekey === config.sitekey && typeof options.callback === 'function' && !options.cData && !options.chlPageData && location.pathname.replace(/\/+$/, '') === config.page.replace(/\/+$/, '') && Date.now() < expires;
      if (!eligible || !node) return render.apply(this, arguments);
      var nativeState = { ready: false };
      var next = Object.assign({}, options, { callback: function (token) { nativeState.ready = true; return options.callback(token); } });
      var widget = render.call(this, container, next);
      setTimeout(function () { void solve(node, options, nativeState); }, 10000);
      return widget;
    }
    wrapped.__ihWrapped = true;
    api.render = wrapped;
  }
  document.addEventListener('load', function (event) {
    if (event.target.tagName === 'SCRIPT' && /^https:\/\/challenges\.cloudflare\.com\/turnstile\//.test(event.target.src || '')) wrap();
  }, true);
  var timer = setInterval(function () {
    wrap();
    if (Date.now() > expires) clearInterval(timer);
  }, 100);
  wrap();
})();
