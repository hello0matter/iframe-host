#!/usr/bin/env node

const assert = require("assert");
const { execFileSync, spawn } = require("child_process");
const fs = require("fs");
const https = require("https");
const os = require("os");
const path = require("path");
const zlib = require("zlib");

const ROOT = __dirname;
const HOST_DIR = ROOT;
const SERVER_SOURCE = path.join(HOST_DIR, "server.js");
const ADMIN_SOURCE = path.join(HOST_DIR, "public", "admin.html");
const dependencies = path.join(HOST_DIR, "node_modules");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "iframe-host-multisite-"));
const tlsDir = path.join(tmp, "tls");
const tlsKeyPath = path.join(tlsDir, "key.pem");
const tlsCertPath = path.join(tlsDir, "cert.pem");
const adminPath = path.join(tmp, "public");
const configPath = path.join(tmp, "config.json");
const visitorPath = path.join(tmp, "visitors.json");
const auditPath = path.join(tmp, "audit-logs");
const fallbackCachePath = path.join(tmp, "fallback-cache.json");
const proxyPort = 18480 + Math.floor(Math.random() * 1000);
const upstreamOnePort = proxyPort + 1;
const upstreamTwoPort = proxyPort + 2;
const password = "test-password-123";
let proxy;
let upstreamOne;
let upstreamTwo;
let lastUpstreamOneHeaders = {};
let lastUpstreamOneUrl = "";
let apiStreamEnded = false;
let apiDisconnected = false;

function listen(server, port) {
  return new Promise(resolve => server.listen(port, "127.0.0.1", resolve));
}

function createTlsUpstream(port, handler) {
  const server = https.createServer({ key: fs.readFileSync(tlsKeyPath), cert: fs.readFileSync(tlsCertPath) }, (req, res) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      const result = handler({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) }, res);
      if (!result) return;
      const responseBody = Buffer.isBuffer(result.body) ? result.body : Buffer.from(result.body || "");
      const headers = { "content-type": result.contentType || "text/plain", "content-length": responseBody.length, ...(result.headers || {}) };
      if (result.contentEncoding) headers["content-encoding"] = result.contentEncoding;
      res.writeHead(result.status || 200, headers);
      res.end(responseBody);
    });
  });
  return { server, port };
}

function close(server) {
  return new Promise(resolve => server ? server.close(resolve) : resolve());
}

function stopProcess(child) {
  return new Promise(resolve => {
    if (!child || child.exitCode !== null || child.killed) return resolve();
    child.once("exit", resolve);
    child.kill("SIGTERM");
  });
}

async function request(url, options = {}) {
  const response = await fetch(url, { redirect: "manual", ...options });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { response, text, json };
}

async function requestBuffer(url, options = {}) {
  const response = await fetch(url, { redirect: "manual", ...options });
  return { response, body: Buffer.from(await response.arrayBuffer()) };
}

async function waitForServer(url, getOutput = () => "") {
  let lastError;
  for (let i = 0; i < 40; i++) {
    try {
      const result = await request(url);
      if (result.response.status < 500) return;
    } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const detail = getOutput().trim();
  throw new Error(`${lastError?.message || "proxy did not start"}${detail ? `\nProxy output:\n${detail}` : ""}`);
}

function apiUrl(pathname) {
  return `http://127.0.0.1:${proxyPort}/admin${pathname}`;
}

async function api(pathname, token, options = {}) {
  const result = await request(apiUrl(pathname), {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  assert.ok(result.response.ok, `${options.method || "GET"} ${pathname}: ${result.response.status} ${result.text}`);
  return result.json;
}

async function main() {
  fs.mkdirSync(adminPath, { recursive: true });
  fs.mkdirSync(tlsDir, { recursive: true });
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", tlsKeyPath, "-out", tlsCertPath, "-subj", "/CN=127.0.0.1", "-days", "1"], { stdio: "ignore" });
  fs.copyFileSync(SERVER_SOURCE, path.join(tmp, "server.js"));
  fs.copyFileSync(path.join(ROOT, 'api-proxy.js'), path.join(tmp, 'api-proxy.js'));
  fs.copyFileSync(path.join(ROOT, 'captcha-service.js'), path.join(tmp, 'captcha-service.js'));
  fs.copyFileSync(path.join(ROOT, 'public', 'captcha-client.js'), path.join(adminPath, 'captcha-client.js'));
  fs.copyFileSync(ADMIN_SOURCE, path.join(adminPath, "admin.html"));
  fs.cpSync(dependencies, path.join(tmp, "node_modules"), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    target_url: `https://127.0.0.1:${upstreamOnePort}/`,
    proxy_prefix: "/one",
    port: proxyPort,
    bind_host: "127.0.0.1",
    admin_path: "admin",
    admin_username: "admin",
    admin_password: password,
    replace_rules: [],
    oauth_bypass_paths: [],
    rewrite_request_headers: true,
  }, null, 2));
  fs.writeFileSync(fallbackCachePath, JSON.stringify({
    entries: {
      "default:/cached": { content_type: "text/html; charset=utf-8", body: "<!doctype html><title>Cached site</title><p>stale fallback</p>" },
      "default:/landing": { content_type: "text/html; charset=utf-8", body: "<!doctype html><script>window.onload=function(){$('.signin-loader:first').click();};</script><script>window.onload=function(){$('#modal-system-notice').modal('show');};</script><p>landing</p>" },
    },
  }));

  upstreamOne = createTlsUpstream(upstreamOnePort, (request, rawResponse) => {
    lastUpstreamOneHeaders = request.headers;
    lastUpstreamOneUrl = request.url;
    if (request.url.startsWith('/v1/')) {
      if (['/v1/stream', '/v1/disconnect', '/v1/idle'].includes(request.url)) {
        rawResponse.writeHead(200, { 'content-type': 'text/event-stream', 'x-api-original': 'yes' });
        rawResponse.write('data: first\n\n');
        if (request.url === '/v1/stream') {
          apiStreamEnded = false;
          setTimeout(() => { apiStreamEnded = true; rawResponse.end('data: last\n\n'); }, 250);
        } else rawResponse.once('close', () => { apiDisconnected = true; });
        return;
      }
      if (request.url === '/v1/slow-headers') {
        const timer = setTimeout(() => { rawResponse.writeHead(200); rawResponse.end('late'); }, 1500);
        rawResponse.once('close', () => clearTimeout(timer));
        return;
      }
      if (request.url === '/v1/delayed') {
        setTimeout(() => { rawResponse.writeHead(200, { 'content-type': 'application/json' }); rawResponse.end('{"slow":true}'); }, 250);
        return;
      }
      if (request.url === '/v1/bytes') return { contentType: 'application/octet-stream', body: request.body };
      if (request.url === '/v1/compressed') return { contentType: 'application/json', contentEncoding: 'gzip', body: zlib.gzipSync(JSON.stringify({ url: `https://127.0.0.1:${upstreamOnePort}/v1/original` })) };
      if (request.url === '/v1/error') return { status: 429, contentType: 'application/json', headers: { 'retry-after': '7' }, body: '{"error":"rate limit"}' };
      return { contentType: 'application/json', body: JSON.stringify({ url: `https://127.0.0.1:${upstreamOnePort}/v1/original`, path: request.url, method: request.method, headers: request.headers, body: request.body.toString('utf8') }) };
    }
    if (request.url.startsWith("/request-mutate")) return { contentType: "application/json", body: JSON.stringify({ url: request.url, headers: request.headers, body: request.body.toString("utf8") }) };
    if (request.url === "/page.html") {
      return {
        contentType: "text/html",
        body: `<!doctype html><html><head><link href="http://127.0.0.1:${upstreamOnePort}/assets/site.css"><link href="//127.0.0.1:${upstreamOnePort}/assets/relative.css"></head><body><img src="http://127.0.0.1:${upstreamOnePort}/assets/logo.png">One<script>window.onload=function(){$('.signin-loader:first').click();};</script><script>window.onload=function(){$('#modal-system-notice').modal('show');};</script></body></html>`,
      };
    }
    if (request.url === "/assets/logo.png") {
      return { contentType: "image/png", body: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) };
    }
    if (request.url === "/compressed.html") {
      return { contentType: "text/html", contentEncoding: "gzip", body: zlib.gzipSync("<!doctype html><title>Compressed page</title><p>decoded fallback</p>") };
    }
    if (request.url === "/config") {
      const body = JSON.stringify({
        root: "/",
        site: `https://127.0.0.1:${upstreamOnePort}`,
        assets: ["/assets/app.js", "/one/already-prefixed.css"],
      });
      return { contentType: "application/json", contentEncoding: "gzip", body: zlib.gzipSync(body) };
    }
    if (request.url === "/binary") {
      return { contentType: "application/octet-stream", body: Buffer.alloc(8192, 7) };
    }
    if (request.url === "/redirect") {
      return { status: 302, headers: { location: `http://127.0.0.1:${upstreamOnePort}/next` }, body: "redirect" };
    }
    if (request.url === "/login-redirect") {
      return { status: 302, headers: { location: "/login?redirect=/one/" }, body: "redirect" };
    }
    if (request.url === "/prefixed-redirect") {
      return { status: 302, headers: { location: "/one/login?redirect=/one/" }, body: "redirect" };
    }
    if (request.url === "/external-redirect") {
      return { status: 302, headers: { location: "https://external.example/login" }, body: "redirect" };
    }
    if (request.url === "/large") {
      return { contentType: "text/plain", body: "x".repeat(1024 * 1024 + 1) };
    }
    if (request.url === "/submit" && request.method === "POST") {
      return { status: 201, contentType: "application/json", body: JSON.stringify({ from: "one", body: request.body.toString("utf8") }) };
    }
    if (request.url === "/json-mutate") {
      return { contentType: "application/json", body: JSON.stringify({ data: { token: "abc", n: 1 }, keep: true }) };
    }
    if (request.url === "/header-mutate") {
      return { contentType: "text/plain", headers: { "x-upstream": "original" }, body: "ok" };
    }
    if (request.url === "/form-mutate") {
      return { contentType: "application/x-www-form-urlencoded", body: "token=abc&n=1" };
    }
    return { contentType: "text/plain", body: "one:" + request.url };
  });
  upstreamTwo = createTlsUpstream(upstreamTwoPort, request => ({ contentType: "text/plain", body: "two:" + request.url }));

  await listen(upstreamOne.server, upstreamOne.port);
  await listen(upstreamTwo.server, upstreamTwo.port);
  proxy = spawn(process.execPath, ["server.js"], {
    cwd: tmp,
    env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: "0", CONFIG_FILE: configPath, VISITOR_DATA_FILE: visitorPath, AUDIT_LOG_DIR: auditPath, FALLBACK_CACHE_FILE: fallbackCachePath, UPSTREAM_TIMEOUT_MS: "100" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverOutput = "";
  proxy.stdout.on("data", chunk => { serverOutput += chunk; });
  proxy.stderr.on("data", chunk => { serverOutput += chunk; });

  await waitForServer(apiUrl("/"), () => serverOutput);
  const migrationBackups = fs.readdirSync(tmp).filter(name => /^config\.json\.legacy-\d+\.bak$/.test(name));
  assert.strictEqual(migrationBackups.length, 1, "legacy configuration backup was not created");
  const migrated = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.strictEqual(migrated.version, 2);
  assert.strictEqual(migrated.sites.length, 1);
  assert.strictEqual(migrated.sites[0].id, "default");

  const login = await request(apiUrl("/api/login"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password }) });
  assert.strictEqual(login.response.status, 200, login.text);
  const token = login.json.token;
  assert.ok(token);

  const publicBase = `http://127.0.0.1:${proxyPort}`;
  const captchaClient = await request(publicBase + '/__ih/captcha/client.js');
  assert.strictEqual(captchaClient.response.status, 200);
  assert.strictEqual(captchaClient.response.headers.get('cache-control'), 'no-store');
  assert.ok(captchaClient.text.includes('__ihCaptchaInstalled'));
  const privateCaptchaStatus = await request(apiUrl('/api/sites/default/captcha-status'));
  assert.strictEqual(privateCaptchaStatus.response.status, 401);
  const adapterSaved = await api('/api/sites/default', token, { method: 'PUT', body: JSON.stringify({ debug_enabled: true, captcha: { enabled: true, site_key: 'public-integration-key', api_key_env: 'CAPTCHA_TEST_ABSENT_ENV', max_tasks_per_hour: 100, waiting_message: '请稍候', ready_message: '验证完成 ✅', expired_message: '验证已过期', busy_message: '已有验证任务，请等待', mode: 'provider_only', response_field_name: 'verification-token', callback_path: 'app.onVerified', result_ttl_seconds: 60 } }) });
  assert.strictEqual(adapterSaved.site.captcha.mode, 'provider_only');
  assert.strictEqual(adapterSaved.site.captcha.max_tasks_per_hour, 100);
  const savedWithLimit = await api('/api/sites/default', token);
  assert.strictEqual(savedWithLimit.site.captcha.max_tasks_per_hour, 100);
  const badLimit = await request(apiUrl('/api/sites/default'), { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ captcha: { max_tasks_per_hour: 101 } }) });
  assert.strictEqual(badLimit.response.status, 400);
  assert.strictEqual(adapterSaved.site.captcha.response_field_name, 'verification-token');
  const badAdapter = await request(apiUrl('/api/sites/default'), { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ captcha: { callback_path: 'constructor.constructor' } }) });
  assert.strictEqual(badAdapter.response.status, 400);
  const captchaStatus = await api('/api/sites/default/captcha-status', token);
  assert.strictEqual(captchaStatus.data.key_configured, false);
  const captchaPage = await request(publicBase + '/one/page.html');
  assert.strictEqual(captchaPage.response.headers.get('cache-control'), 'no-store');
  const captchaCookie = captchaPage.response.headers.get('set-cookie').match(/ih_captcha_browser=[a-f0-9]+/)[0];
  const captchaConfig = JSON.parse(Buffer.from(captchaPage.text.match(/data-captcha="([A-Za-z0-9_-]+)"/)[1], 'base64url').toString());
  assert.strictEqual(captchaConfig.page, '/one/login');
  assert.strictEqual(captchaConfig.mode, 'provider_only');
  assert.strictEqual(captchaConfig.responseFieldName, 'verification-token');
  assert.strictEqual(captchaConfig.callbackPath, 'app.onVerified');
  assert.strictEqual(captchaConfig.resultTtl, 60);
  assert.strictEqual(captchaConfig.messages.waiting, '请稍候');
  assert.strictEqual(captchaConfig.messages.ready, '验证完成 ✅');
  assert.strictEqual(captchaConfig.messages.expired, '验证已过期');
  assert.strictEqual(captchaConfig.messages.CAPTCHA_BUSY, '已有验证任务，请等待');
  assert.strictEqual(savedWithLimit.site.captcha.expired_message, '验证已过期');
  assert.strictEqual(savedWithLimit.site.captcha.busy_message, '已有验证任务，请等待');
  assert.strictEqual(savedWithLimit.site.captcha.ready_message, '验证完成 ✅');
  const captchaBody = JSON.stringify({ ticket: captchaConfig.ticket, metadata: { sitekey: 'public-integration-key' } });
  const postCaptcha = headers => request(publicBase + '/__ih/captcha/default', { method: 'POST', headers: { 'content-type': 'application/json', cookie: captchaCookie, ...headers }, body: captchaBody });
  const postDiagnostic = (headers = {}, event = 'client_loaded') => request(publicBase + '/__ih/captcha/default/diagnostics', { method: 'POST', headers: { 'content-type': 'application/json', cookie: captchaCookie, ...headers }, body: JSON.stringify({ ticket: captchaConfig.ticket, event, token: 'must-not-appear-in-logs' }) });
  assert.strictEqual((await postDiagnostic()).response.status, 403);
  assert.strictEqual((await postDiagnostic({ origin: 'https://foreign.example' })).response.status, 403);
  assert.strictEqual((await postDiagnostic({ origin: publicBase, cookie: '' })).response.status, 403);
  assert.strictEqual((await postDiagnostic({ origin: publicBase })).response.status, 200);
  assert.strictEqual((await postDiagnostic({ origin: publicBase }, 'arbitrary-client-text')).response.status, 400);
  const diagnosticStatus = (await api('/api/sites/default/captcha-status', token)).data;
  assert.strictEqual(diagnosticStatus.enabled, true);
  assert.strictEqual(diagnosticStatus.debug_enabled, true);
  assert.strictEqual(diagnosticStatus.tasks_this_hour, 0);
  assert.strictEqual(diagnosticStatus.recent_events[0].event, 'client_loaded');
  assert.ok(!JSON.stringify(diagnosticStatus).includes('must-not-appear-in-logs'));

  assert.strictEqual((await postCaptcha({})).response.status, 403);
  assert.strictEqual((await postCaptcha({ origin: 'https://foreign.example' })).response.status, 403);
  assert.strictEqual((await postCaptcha({ origin: publicBase, 'sec-fetch-site': 'cross-site' })).response.status, 403);
  assert.strictEqual((await postCaptcha({ origin: publicBase, cookie: '' })).response.status, 403);
  const missingCaptchaKey = await postCaptcha({ origin: publicBase });
  assert.strictEqual(missingCaptchaKey.response.status, 503);
  assert.strictEqual(missingCaptchaKey.json.error, 'CAPTCHA_KEY_MISSING');
  assert.strictEqual((await api('/api/sites/default/captcha-status', token)).data.tasks_this_hour, 0);
  await api('/api/sites/default', token, { method: 'PUT', body: JSON.stringify({ debug_enabled: false }) });
  assert.strictEqual((await postDiagnostic({ origin: publicBase })).response.status, 404);
  const quietStatus = (await api('/api/sites/default/captcha-status', token)).data;
  assert.strictEqual(quietStatus.debug_enabled, false);
  assert.deepStrictEqual(quietStatus.recent_events, []);
  await api('/api/sites/default', token, { method: 'PUT', body: JSON.stringify({ debug_enabled: false, captcha: { enabled: false } }) });
  assert.strictEqual((await postCaptcha({ origin: publicBase })).response.status, 404);

  const added = await api("/api/sites", token, { method: "POST", body: JSON.stringify({
    id: "two", name: "Second site", enabled: true, target_url: `https://127.0.0.1:${upstreamTwoPort}/`, proxy_prefix: "/two",
    replace_rules: [], oauth_bypass_paths: [], rewrite_request_headers: true, audit_probe: { enabled: false },
  }) });
  assert.strictEqual(added.site.id, "two");
  const adminHtml = fs.readFileSync(ADMIN_SOURCE, "utf8");
  assert.ok(!adminHtml.includes("proxy-location-notice"), "admin UI must not include the tracking popup");
  assert.ok(!adminHtml.includes("navigator.geolocation"), "admin UI must not request browser location");
  assert.ok(adminHtml.includes("location.pathname.replace(/\\/+$/,'')||'/'"), "admin UI must normalize its current route as the API base");
  const proxiedHtml = await request(`http://127.0.0.1:${proxyPort}/one/page.html`);
  assert.strictEqual(proxiedHtml.response.status, 200);
  assert.ok(!proxiedHtml.text.includes("proxy-location-notice"), "proxied HTML must not inject a tracking popup");
  assert.ok(!proxiedHtml.text.includes("navigator.geolocation"), "proxied HTML must not request browser location");
  assert.ok(proxiedHtml.text.includes("/__ih/track"), "proxied HTML must post analytics to the reserved public track path");
  assert.ok(proxiedHtml.text.includes("data.consent={optional_tracking:true,precise_location:false,location_status:'not_requested'}"), "proxied HTML must enable anonymous analytics without location permission");
  assert.ok(proxiedHtml.text.includes("withPrefix"), "proxied HTML must rewrite absolute fetch paths under a site prefix");
  assert.ok(proxiedHtml.text.includes("prefixResource"), "proxied HTML must prefix dynamically inserted resources");
  assert.ok(!proxiedHtml.text.includes("#modal-system-notice"), "proxied HTML must not force a system-notice overlay");
  assert.ok(!proxiedHtml.text.includes(".signin-loader:first"), "proxied HTML must not force a sign-in overlay");
  assert.ok(proxiedHtml.text.includes("/one/assets/site.css"), "http origin assets must be rewritten under a site prefix");
  assert.ok(proxiedHtml.text.includes("/one/assets/relative.css"), "protocol-relative assets must be rewritten under a site prefix");
  assert.ok(!proxiedHtml.text.includes("http:/one/"), "origin rewriting must not produce malformed http:/ URLs");
  assert.strictEqual(lastUpstreamOneHeaders["accept-encoding"], "identity", "upstream text must be requested without compression");
  const proxiedImage = await requestBuffer(`http://127.0.0.1:${proxyPort}/one/assets/logo.png`);
  assert.strictEqual(proxiedImage.response.status, 200);
  assert.deepStrictEqual(proxiedImage.body, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const compressedPage = await request(`http://127.0.0.1:${proxyPort}/one/compressed.html`);
  assert.strictEqual(compressedPage.response.status, 200);
  assert.ok(compressedPage.text.includes("decoded fallback"));
  const proxiedRedirect = await request(`http://127.0.0.1:${proxyPort}/one/redirect`);
  assert.strictEqual(proxiedRedirect.response.status, 302);
  assert.strictEqual(proxiedRedirect.response.headers.get("location"), "/one/next");
  const proxiedJson = await request(`http://127.0.0.1:${proxyPort}/one/config`);
  assert.strictEqual(proxiedJson.response.status, 200);
  assert.deepStrictEqual(proxiedJson.json, {
    root: "/one/",
    site: "/one/",
    assets: ["/one/assets/app.js", "/one/already-prefixed.css"],
  });
  const duplicate = await request(apiUrl("/api/sites"), { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ id: "conflict", name: "Conflict", target_url: `https://127.0.0.1:${upstreamTwoPort}/`, proxy_prefix: "/two" }) });
  assert.strictEqual(duplicate.response.status, 400);

  const interceptCode = 'return { status: 201, headers: { "x-intercept": "yes" }, body: { path: request.path, query: request.query, cookie: request.cookies.session || null, auth: request.headers.authorization || null, custom: request.headers["x-custom"] || null } };';
  await api("/api/sites/default", token, { method: "PUT", body: JSON.stringify({
    intercept: {
      enabled: true, url_pattern: "^/intercept-me", match_mode: "regex", status: 200,
      content_type: "application/json; charset=utf-8", timeout_ms: 1000, code: interceptCode,
    },
  }) });
  const intercepted = await request(`http://127.0.0.1:${proxyPort}/one/intercept-me?a=1`, {
    headers: { Cookie: "session=abc123", Authorization: "Bearer tok", "X-Custom": "custom-value" },
  });
  assert.strictEqual(intercepted.response.status, 201, intercepted.text);
  assert.strictEqual(intercepted.response.headers.get("x-intercept"), "yes");
  assert.deepStrictEqual(intercepted.json, {
    path: "/intercept-me", query: "?a=1", cookie: "abc123", auth: "Bearer tok", custom: "custom-value",
  }, "intercept script must receive headers and cookies");
  await api("/api/sites/default", token, { method: "PUT", body: JSON.stringify({
    intercept: { enabled: false, url_pattern: "^/intercept-me", match_mode: "regex", code: "" },
  }) });
  const notIntercepted = await request(`http://127.0.0.1:${proxyPort}/one/intercept-me`);
  assert.strictEqual(notIntercepted.response.status, 200);
  assert.ok(notIntercepted.text.startsWith("one:"), "disabled intercept must proxy to upstream");

  const routeOne = await request(`http://127.0.0.1:${proxyPort}/one/hello?x=1`);
  const routeTwo = await request(`http://127.0.0.1:${proxyPort}/two/hello?x=1`);
  assert.strictEqual(routeOne.text, "one:/hello?x=1");
  assert.strictEqual(routeTwo.text, "two:/hello?x=1");
  const loginRedirect = await request(`http://127.0.0.1:${proxyPort}/one/login-redirect`);
  assert.strictEqual(loginRedirect.response.headers.get('location'), '/one/login?redirect=/one/');
  const prefixedRedirect = await request(`http://127.0.0.1:${proxyPort}/one/prefixed-redirect`);
  assert.strictEqual(prefixedRedirect.response.headers.get('location'), '/one/login?redirect=/one/');
  const externalRedirect = await request(`http://127.0.0.1:${proxyPort}/one/external-redirect`);
  assert.strictEqual(externalRedirect.response.headers.get('location'), 'https://external.example/login');

  const responseRules = [
    { enabled: true, url_pattern: "/json-mutate", match_mode: "literal", target: "json", key: "data.token", code: 'return value + "-x";', timeout_ms: 1000 },
    { enabled: true, url_pattern: "/json-mutate", match_mode: "literal", target: "json", key: "data.n", code: "return Number(value) + 10;", timeout_ms: 1000 },
    { enabled: true, url_pattern: "/header-mutate", match_mode: "literal", target: "header", key: "x-upstream", code: 'return "changed-" + value;', timeout_ms: 1000 },
    { enabled: true, url_pattern: "/form-mutate", match_mode: "literal", target: "form", key: "token", code: 'return value + "-f";', timeout_ms: 1000 },
  ];
  const rulesUpdate = await api("/api/sites/default", token, { method: "PUT", body: JSON.stringify({ response_rules: responseRules }) });
  assert.strictEqual(rulesUpdate.site.response_rules.length, 4);
  const jsonMutated = await request(`http://127.0.0.1:${proxyPort}/one/json-mutate`);
  assert.deepStrictEqual(jsonMutated.json, { data: { token: "abc-x", n: 11 }, keep: true });
  const headerMutated = await request(`http://127.0.0.1:${proxyPort}/one/header-mutate`);
  assert.strictEqual(headerMutated.response.headers.get("x-upstream"), "changed-original");
  const formMutated = await request(`http://127.0.0.1:${proxyPort}/one/form-mutate`);
  assert.ok(formMutated.text.includes("token=abc-f"), formMutated.text);
  assert.ok(formMutated.text.includes("n=1"), formMutated.text);
  const unaffectedPage = await request(`http://127.0.0.1:${proxyPort}/one/page.html`);
  assert.ok(unaffectedPage.text.includes("One"), "response rules must only affect matching URLs");

  assert.ok(rulesUpdate.site.response_rules.every(rule => rule.direction === "response"), "legacy rules default to response");
  const rule = (target, key, code, extra = {}) => ({ enabled: true, direction: "request", url_pattern: "/request-mutate", match_mode: "literal", target, key, code, ...extra });
  const requestRules = [
    rule("query", "lang", 'return "zh-CN";'),
    rule("query", "remove", "return null;"),
    rule("header", "x-custom", 'console.log("do-not-record-log-args"); return value + "-sent";'),
    rule("header", "x-stage", 'return response === null ? request.query : "wrong";'),
    rule("header", "x-drop", "return null;"),
    rule("header", "host", 'return "invalid.example";'),
    rule("header", "content-length", 'return "999999";'),
    rule("header", "x-inject", 'return "bad\\r\\nheader: yes";'),
    rule("json", "data.n", "return Number(value) + 10;"),
    rule("json", "data.keep", "return undefined;"),
    rule("json", "data.note", 'return "中文";'),
    rule("form", "token", 'return value + "-sent";'),
    rule("text", "marker=(abc)", 'return "xyz";'),
    rule("header", "x-error", 'throw new Error("mock failure");'),
    rule("header", "x-invalid-value", 'return "中文";'),
    rule("header", "x-disabled", 'return "no";', { enabled: false }),
    rule("header", "x-other", 'return "no";', { url_pattern: "/elsewhere" }),
  ];
  await api("/api/sites/default", token, { method: "PUT", body: JSON.stringify({ response_rules: [...responseRules, ...requestRules] }) });
  const sendRequestRule = (body, contentType) => request(`http://127.0.0.1:${proxyPort}/one/request-mutate?remove=1&keep=2`, {
    method: "POST", headers: { "content-type": contentType, "x-custom": "original", "x-drop": "remove" }, body,
  });
  const savedRequestRules = await api("/api/sites/default", token);
  assert.ok(savedRequestRules.site.response_rules.some(item => item.direction === "request" && item.target === "query"));
  const diskRules = JSON.parse(fs.readFileSync(configPath, "utf8")).sites.find(site => site.id === "default").response_rules;
  assert.ok(diskRules.some(item => item.direction === "request" && item.target === "query"));
  const otherSite = await request(`http://127.0.0.1:${proxyPort}/two/request-mutate?lang=en`);
  assert.ok(otherSite.text.includes("lang=en"), "request rules must not affect other sites");
  const changedRequest = await sendRequestRule(JSON.stringify({ data: { n: 1, keep: true } }), "application/json");
  assert.strictEqual(changedRequest.response.status, 200, changedRequest.text);
  assert.deepStrictEqual(JSON.parse(changedRequest.json.body), { data: { n: 11, keep: true, note: "中文" } });
  assert.strictEqual(lastUpstreamOneUrl, "/request-mutate?keep=2&lang=zh-CN");
  assert.strictEqual(changedRequest.json.url, "/one/request-mutate?keep=2&lang=zh-CN");
  assert.strictEqual(changedRequest.json.headers["x-custom"], "original-sent");
  assert.strictEqual(changedRequest.json.headers["x-stage"], "?keep=2&lang=zh-CN");
  assert.strictEqual(changedRequest.json.headers["x-drop"], undefined);
  assert.strictEqual(changedRequest.json.headers["x-inject"], undefined);
  assert.strictEqual(changedRequest.json.headers["x-error"], undefined);
  assert.strictEqual(changedRequest.json.headers["x-invalid-value"], undefined);
  assert.strictEqual(changedRequest.json.headers["x-disabled"], undefined);
  assert.strictEqual(changedRequest.json.headers["x-other"], undefined);
  assert.strictEqual(changedRequest.json.headers.host, `127.0.0.1:${upstreamOnePort}`);
  assert.strictEqual(Number(changedRequest.json.headers["content-length"]), Buffer.byteLength(changedRequest.json.body));
  assert.ok(!serverOutput.includes('[value-rule]'), 'debug off must suppress script logs');
  await api("/api/sites/default", token, { method: "PUT", body: JSON.stringify({ value_rules_enabled: false }) });
  const disabledRules = await sendRequestRule("multipart-original", "multipart/form-data; boundary=x");
  assert.strictEqual(disabledRules.response.status, 200);
  assert.strictEqual(disabledRules.json.body, "multipart-original");
  assert.strictEqual(disabledRules.json.headers["x-custom"], "original");
  assert.strictEqual(lastUpstreamOneUrl, "/request-mutate?remove=1&keep=2");
  assert.strictEqual((await api("/api/sites/default", token)).site.value_rules_enabled, false);
  await api("/api/sites/default", token, { method: "PUT", body: JSON.stringify({ value_rules_enabled: true, debug_enabled: true }) });
  for (let i = 0; i < 4; i++) await sendRequestRule('{"data":{"n":1}}', "application/json");
  await new Promise(resolve => setTimeout(resolve, 30));
  const debugLines = serverOutput.split('\n').filter(line => line.includes('[value-rule]'));
  assert.ok(debugLines.length > 0 && debugLines.length <= 60, 'debug logs must be bounded per site');
  assert.ok(!debugLines.join('').includes('do-not-record-log-args'));
  await api("/api/sites/default", token, { method: "PUT", body: JSON.stringify({ debug_enabled: false }) });
  await sendRequestRule('{"data":{"n":1}}', "application/json");
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.strictEqual(serverOutput.split('\n').filter(line => line.includes('[value-rule]')).length, debugLines.length);
  const formRequest = await sendRequestRule("token=abc&keep=1", "application/x-www-form-urlencoded");
  assert.strictEqual(formRequest.json.body, "token=abc-sent&keep=1");
  const textRequest = await sendRequestRule("marker=abc", "text/plain");
  assert.strictEqual(textRequest.json.body, "marker=xyz");
  const getRequest = await request(`http://127.0.0.1:${proxyPort}/one/request-mutate?remove=1&keep=2`);
  assert.strictEqual(getRequest.json.url, "/one/request-mutate?keep=2&lang=zh-CN");
  assert.strictEqual(getRequest.json.body, "");
  for (const headers of [{}, { "content-length": "0" }, { "content-length": "0", "content-type": "application/octet-stream" }]) {
    const emptyRequest = await request(`http://127.0.0.1:${proxyPort}/one/request-mutate/orders/123/cancel?remove=1&keep=2`, {
      method: "POST", headers: { ...headers, "x-custom": "original" },
    });
    assert.strictEqual(emptyRequest.response.status, 200, emptyRequest.text);
    assert.strictEqual(emptyRequest.json.body, "");
    assert.strictEqual(emptyRequest.json.headers["x-custom"], "original-sent");
    assert.strictEqual(lastUpstreamOneUrl, "/request-mutate/orders/123/cancel?keep=2&lang=zh-CN");
  }
  const untouchedResponse = await request(`http://127.0.0.1:${proxyPort}/one/json-mutate`);
  assert.deepStrictEqual(untouchedResponse.json, { data: { token: "abc-x", n: 11 }, keep: true });
  const tooLarge = await sendRequestRule("x".repeat(1024 * 1024 + 1), "text/plain");
  assert.strictEqual(tooLarge.response.status, 413);
  const multipart = await sendRequestRule("not-multipart", "multipart/form-data; boundary=x");
  assert.strictEqual(multipart.response.status, 415);
  const compressed = await request(`http://127.0.0.1:${proxyPort}/one/request-mutate`, { method: "POST", headers: { "content-type": "application/json", "content-encoding": "gzip" }, body: zlib.gzipSync('{}') });
  assert.strictEqual(compressed.response.status, 415);
  for (const invalid of [rule("query", "a", "return 1;", { direction: "response" }), rule("json", "a", "return 1;", { direction: "invalid" })]) {
    const rejected = await request(apiUrl("/api/sites/default"), { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ response_rules: [invalid] }) });
    assert.strictEqual(rejected.response.status, 400);
  }
  await api("/api/sites/default", token, { method: "PUT", body: JSON.stringify({ response_rules: responseRules }) });

  await api("/api/sites/default", token, { method: "PUT", body: JSON.stringify({ response_rules: [rule("header", "x-custom", 'return "streamed";')] }) });
  const uploadBody = "x".repeat(1024 * 1024 + 1);
  const upload = await sendRequestRule(uploadBody, "multipart/form-data; boundary=x");
  assert.strictEqual(upload.response.status, 200);
  assert.strictEqual(upload.json.body, uploadBody);
  assert.strictEqual(upload.json.headers["x-custom"], "streamed");
  await api("/api/sites/default", token, { method: "PUT", body: JSON.stringify({ response_rules: responseRules }) });

  const apiConfig = { enabled: true, path_prefixes: ['/v1'], first_byte_timeout_seconds: 1, idle_timeout_seconds: 1, apply_request_rules: false, rewrite_request_headers: false };
  const apiRules = [
    rule('header', 'x-api-rule', 'return "changed";', { url_pattern: '/v1' }),
    { enabled: true, direction: 'response', url_pattern: '/v1', match_mode: 'literal', target: 'json', key: 'url', code: 'return "wrong";' },
  ];
  const apiSaved = await api('/api/sites/default', token, { method: 'PUT', body: JSON.stringify({ api_proxy: apiConfig, response_rules: apiRules, audit_probe: { enabled: true }, intercept: { enabled: true, url_pattern: '/v1', match_mode: 'literal', code: 'return "intercepted";' } }) });
  assert.deepStrictEqual(apiSaved.site.api_proxy, apiConfig);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')).sites.find(s => s.id === 'default').api_proxy, apiConfig);
  const apiBase = `http://127.0.0.1:${proxyPort}/one`;
  const apiHeaders = { Authorization: 'Bearer test-api-key', 'content-type': 'application/json', Origin: `http://127.0.0.1:${proxyPort}`, Referer: `${apiBase}/login` };
  const apiBody = JSON.stringify({ message: '中文', stream: true });
  const echoed = await request(apiBase + '/v1/echo?x=1', { method: 'POST', headers: apiHeaders, body: apiBody });
  assert.strictEqual(echoed.response.status, 200, echoed.text);
  assert.strictEqual(echoed.json.url, `https://127.0.0.1:${upstreamOnePort}/v1/original`);
  assert.strictEqual(echoed.json.path, '/v1/echo?x=1');
  assert.strictEqual(echoed.json.body, apiBody);
  assert.strictEqual(echoed.json.headers.authorization, 'Bearer test-api-key');
  assert.strictEqual(echoed.json.headers.origin, apiHeaders.Origin);
  assert.strictEqual(echoed.json.headers.referer, apiHeaders.Referer);
  assert.strictEqual(echoed.json.headers['x-api-rule'], undefined);
  assert.strictEqual(echoed.response.headers.get('x-accel-buffering'), 'no');
  const binaryApiBody = Buffer.from([0, 1, 255, 128]);
  const apiBinary = await requestBuffer(apiBase + '/v1/bytes', { method: 'POST', body: binaryApiBody });
  assert.deepStrictEqual(apiBinary.body, binaryApiBody);
  const compressedApiBody = zlib.gzipSync(apiBody);
  const apiCompressedUpload = await requestBuffer(apiBase + '/v1/bytes', { method: 'POST', headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' }, body: compressedApiBody });
  assert.deepStrictEqual(apiCompressedUpload.body, compressedApiBody);
  const apiCompressed = await request(apiBase + '/v1/compressed');
  assert.strictEqual(apiCompressed.response.headers.get('content-encoding'), 'gzip');
  assert.strictEqual(apiCompressed.json.url, `https://127.0.0.1:${upstreamOnePort}/v1/original`);
  const apiError = await request(apiBase + '/v1/error');
  assert.strictEqual(apiError.response.status, 429);
  assert.strictEqual(apiError.response.headers.get('retry-after'), '7');
  const slowApi = await request(apiBase + '/v1/delayed');
  assert.strictEqual(slowApi.response.status, 200, slowApi.text);
  assert.deepStrictEqual(slowApi.json, { slow: true });
  const apiStream = await fetch(apiBase + '/v1/stream');
  const streamReader = apiStream.body.getReader();
  assert.strictEqual(apiStream.headers.get('x-api-original'), 'yes');
  assert.ok(Buffer.from((await streamReader.read()).value).toString().includes('data: first'));
  assert.strictEqual(apiStreamEnded, false, 'SSE must not wait for the complete response even with audit and response rules enabled');
  let streamTail = '';
  for (;;) { const chunk = await streamReader.read(); if (chunk.done) break; streamTail += Buffer.from(chunk.value).toString(); }
  assert.ok(streamTail.includes('data: last'));
  const disconnectedStream = await fetch(apiBase + '/v1/disconnect');
  const disconnectedReader = disconnectedStream.body.getReader();
  await disconnectedReader.read();
  await disconnectedReader.cancel();
  for (let i = 0; i < 30 && !apiDisconnected; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.strictEqual(apiDisconnected, true, 'client cancellation must stop upstream streaming');
  const idleStream = await fetch(apiBase + '/v1/idle');
  const idleReader = idleStream.body.getReader();
  await idleReader.read();
  await assert.rejects(idleReader.read(), /terminated|aborted|socket/i);
  const apiTimedOut = await request(apiBase + '/v1/slow-headers');
  assert.strictEqual(apiTimedOut.response.status, 504);
  assert.strictEqual((await request(apiBase + '/v1/echo')).response.status, 200, 'API timeouts must not trip the web fallback circuit');
  assert.strictEqual((await api('/api/sites/default/audit-logs', token)).total, 0, 'API payloads must not enter the web audit store');
  await api('/api/sites/default', token, { method: 'PUT', body: JSON.stringify({ audit_probe: { enabled: false } }) });
  assert.strictEqual((await request(apiBase + '/v10/hello')).text, 'intercepted', '/v10 must keep web intercept behavior, not match /v1 API mode');
  assert.strictEqual((await request(`http://127.0.0.1:${proxyPort}/two/v1/echo`)).text, 'two:/v1/echo');
  await api('/api/sites/default', token, { method: 'PUT', body: JSON.stringify({ api_proxy: { ...apiConfig, apply_request_rules: true, rewrite_request_headers: true } }) });
  const apiWithRules = await request(apiBase + '/v1/echo', { headers: apiHeaders });
  assert.strictEqual(apiWithRules.json.headers['x-api-rule'], 'changed');
  assert.strictEqual(apiWithRules.json.headers.origin, `https://127.0.0.1:${upstreamOnePort}`);
  assert.strictEqual(apiWithRules.json.headers.referer, `https://127.0.0.1:${upstreamOnePort}/login`);
  for (const invalid of [{ first_byte_timeout_seconds: 0 }, { idle_timeout_seconds: 3601 }, { path_prefixes: ['/v1?x=1'] }]) {
    const rejected = await request(apiUrl('/api/sites/default'), { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ api_proxy: { ...apiConfig, ...invalid } }) });
    assert.strictEqual(rejected.response.status, 400);
  }
  assert.strictEqual((await api('/api/sites/default/audit-logs', token)).total, 0, 'API payloads must not enter the web audit store');
  await api('/api/sites/default', token, { method: 'PUT', body: JSON.stringify({ api_proxy: { ...apiConfig, enabled: false }, response_rules: responseRules, audit_probe: { enabled: false }, intercept: { enabled: false } }) });
  const restoredWeb = await request(apiBase + '/v1/echo');
  assert.strictEqual(restoredWeb.response.status, 200);
  assert.ok(restoredWeb.json.url.includes('/one/v1/original'), 'turning off passthrough restores web response rewriting');

  const beforeAudit = await api("/api/sites/default/audit-logs", token);
  assert.strictEqual(beforeAudit.total, 0);
  const auditUpdate = await api("/api/sites/default", token, { method: "PUT", body: JSON.stringify({ audit_probe: { enabled: true } }) });
  assert.strictEqual(auditUpdate.site.audit_probe.enabled, true);
  const submitted = await request(`http://127.0.0.1:${proxyPort}/one/submit`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret: "audit-body" }) });
  assert.strictEqual(submitted.response.status, 201);
  assert.strictEqual(submitted.json.body, '{"secret":"audit-body"}');
  await request(`http://127.0.0.1:${proxyPort}/one/large`);
  await request(`http://127.0.0.1:${proxyPort}/one/binary`);
  await new Promise(resolve => setTimeout(resolve, 800));
  const audited = await api("/api/sites/default/audit-logs?limit=20", token);
  assert.strictEqual(audited.total, 3);
  const submitRow = audited.data.find(row => row.request.path === "/submit");
  assert.ok(submitRow, "submit audit record missing");
  const detail = await api(`/api/sites/default/audit-logs/${submitRow.id}`, token);
  assert.ok(detail.data.request.body.includes("audit-body"));

  const tracked = await request(`http://127.0.0.1:${proxyPort}/__ih/track`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ site_id: "two", type: "pageview", page: "/welcome", data: { fingerprint: "site-two-visitor" } }) });
  assert.strictEqual(tracked.response.status, 200, tracked.text);
  const analyticsOne = await api("/api/sites/default/analytics/summary", token);
  const analyticsTwo = await api("/api/sites/two/analytics/summary", token);
  assert.strictEqual(analyticsOne.data.total_visitors, 0);
  assert.strictEqual(analyticsTwo.data.total_visitors, 1);

  const badClear = await request(apiUrl("/api/sites/default/audit-logs"), { method: "DELETE", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ confirm: "CLEAR no" }) });
  assert.strictEqual(badClear.response.status, 400);
  const cleared = await api("/api/sites/default/audit-logs", token, { method: "DELETE", body: JSON.stringify({ confirm: "CLEAR default" }) });
  assert.strictEqual(cleared.removed, 3);
  assert.strictEqual((await api("/api/sites/default/audit-logs", token)).total, 0);

  await api("/api/sites/default", token, { method: "PUT", body: JSON.stringify({ target_url: "https://127.0.0.1:1/" }) });
  await api('/api/sites/default', token, { method: 'PUT', body: JSON.stringify({ api_proxy: { enabled: true, path_prefixes: ['/cached'] } }) });
  const uncachedApiFailure = await request(`http://127.0.0.1:${proxyPort}/one/cached`);
  assert.strictEqual(uncachedApiFailure.response.status, 502, 'API failures must not return a cached web page');
  assert.strictEqual(uncachedApiFailure.response.headers.get('x-iframe-fallback'), null);
  await api('/api/sites/default', token, { method: 'PUT', body: JSON.stringify({ api_proxy: { enabled: false } }) });
  const cached = await request(`http://127.0.0.1:${proxyPort}/one/cached`);
  assert.strictEqual(cached.response.status, 200);
  assert.strictEqual(cached.response.headers.get("x-iframe-fallback"), "stale");
  assert.ok(cached.text.includes("stale fallback"));
  const cachedWithQuery = await request(`http://127.0.0.1:${proxyPort}/one/cached?refresh=1`);
  assert.strictEqual(cachedWithQuery.response.status, 200);
  assert.ok(cachedWithQuery.text.includes("stale fallback"));
  const cachedLanding = await request(`http://127.0.0.1:${proxyPort}/one/landing`);
  assert.strictEqual(cachedLanding.response.status, 200);
  assert.strictEqual(cachedLanding.response.headers.get("x-iframe-fallback"), "stale");
  assert.ok(!cachedLanding.text.includes("#modal-system-notice"), "fallback HTML must not force a system-notice overlay");
  assert.ok(!cachedLanding.text.includes(".signin-loader:first"), "fallback HTML must not force a sign-in overlay");
  const staleImage = await requestBuffer(`http://127.0.0.1:${proxyPort}/one/assets/logo.png`);
  assert.strictEqual(staleImage.response.status, 200);
  assert.strictEqual(staleImage.response.headers.get("x-iframe-fallback"), "stale");
  assert.strictEqual(staleImage.response.headers.get("content-type"), "image/png");
  assert.deepStrictEqual(staleImage.body, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const staleCompressedPage = await request(`http://127.0.0.1:${proxyPort}/one/compressed.html`);
  assert.strictEqual(staleCompressedPage.response.status, 200);
  assert.strictEqual(staleCompressedPage.response.headers.get("content-encoding"), null);
  assert.ok(staleCompressedPage.text.includes("decoded fallback"));

  const disabled = await api("/api/sites/two", token, { method: "PUT", body: JSON.stringify({ enabled: false }) });
  assert.strictEqual(disabled.site.enabled, false);
  const disabledRoute = await request(`http://127.0.0.1:${proxyPort}/two/hello`);
  assert.strictEqual(disabledRoute.response.status, 404);

  console.log("PASS: legacy migration, site CRUD, route isolation, analytics isolation, audit capture boundaries, and clear confirmation.");
  if (serverOutput.includes("Audit log write failed")) throw new Error(serverOutput);
}

main().catch(error => {
  console.error("FAIL:", error.stack || error.message);
  process.exitCode = 1;
}).finally(async () => {
  await stopProcess(proxy);
  await close(upstreamOne?.server);
  await close(upstreamTwo?.server);
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});
