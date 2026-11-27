(function () {
  if (window.__ihPaymentCapture) return;
  window.__ihPaymentCapture = true;
  var script = document.currentScript;
  if (!script) return;
  var site = script.getAttribute('data-ih-payment-site') || '';
  var pattern = script.getAttribute('data-ih-payment-pattern') || '';
  var mode = script.getAttribute('data-ih-payment-mode') || 'regex';
  var fields = {};
  try { fields = JSON.parse(script.getAttribute('data-ih-payment-fields') || '{}'); } catch (e) { return; }
  function matches(url) {
    var path = url;
    try { path = new URL(url, location.href).pathname; } catch (e) {}
    if (mode === 'literal') return path.indexOf(pattern) !== -1;
    try { return new RegExp(pattern).test(path); } catch (e) { return false; }
  }
  function valueAt(object, key) {
    if (!key) return undefined;
    var current = object;
    var parts = String(key).split('.');
    for (var i = 0; i < parts.length; i += 1) {
      if (!current || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, parts[i])) return undefined;
      current = current[parts[i]];
    }
    return current;
  }
  function send(url, method, response) {
    if (!matches(url) || !response || typeof response !== 'object') return;
    var body = { url: url, method: method, response: response };
    fetch('/__ih/payment/capture/' + encodeURIComponent(site), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'same-origin',
      keepalive: true
    }).catch(function () {});
  }
  var originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function (input, init) {
      var requestUrl = typeof input === 'string' ? input : input && input.url;
      var method = init && init.method || input && input.method || 'GET';
      return originalFetch.apply(this, arguments).then(function (response) {
        if (matches(requestUrl)) {
          response.clone().json().then(function (data) { send(requestUrl, method, data); }).catch(function () {});
        }
        return response;
      });
    };
  }
  if (window.XMLHttpRequest && window.XMLHttpRequest.prototype) {
    var originalOpen = window.XMLHttpRequest.prototype.open;
    var originalSend = window.XMLHttpRequest.prototype.send;
    window.XMLHttpRequest.prototype.open = function (method, url) {
      this.__ihPaymentMethod = method;
      this.__ihPaymentUrl = url;
      return originalOpen.apply(this, arguments);
    };
    window.XMLHttpRequest.prototype.send = function () {
      var xhr = this;
      xhr.addEventListener('load', function () {
        try { send(xhr.__ihPaymentUrl, xhr.__ihPaymentMethod, JSON.parse(xhr.responseText)); } catch (e) {}
      });
      return originalSend.apply(this, arguments);
    };
  }
})();
