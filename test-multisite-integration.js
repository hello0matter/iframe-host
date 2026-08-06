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

function listen(server, port) {
  return new Promise(resolve => server.listen(port, "127.0.0.1", resolve));
}

function createTlsUpstream(port, handler) {
  const server = https.createServer({ key: fs.readFileSync(tlsKeyPath), cert: fs.readFileSync(tlsCertPath) }, (req, res) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      const result = handler({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
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

  upstreamOne = createTlsUpstream(upstreamOnePort, request => {
    lastUpstreamOneHeaders = request.headers;
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
    if (request.url === "/large") {
      return { contentType: "text/plain", body: "x".repeat(1024 * 1024 + 1) };
    }
    if (request.url === "/submit" && request.method === "POST") {
      return { status: 201, contentType: "application/json", body: JSON.stringify({ from: "one", body: request.body.toString("utf8") }) };
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

  const routeOne = await request(`http://127.0.0.1:${proxyPort}/one/hello?x=1`);
  const routeTwo = await request(`http://127.0.0.1:${proxyPort}/two/hello?x=1`);
  assert.strictEqual(routeOne.text, "one:/hello?x=1");
  assert.strictEqual(routeTwo.text, "two:/hello?x=1");

  const beforeAudit = await api("/api/sites/default/audit-logs", token);
  assert.strictEqual(beforeAudit.total, 0);
  const auditUpdate = await api("/api/sites/default", token, { method: "PUT", body: JSON.stringify({ audit_probe: { enabled: true } }) });
  assert.strictEqual(auditUpdate.site.audit_probe.enabled, false);
  const submitted = await request(`http://127.0.0.1:${proxyPort}/one/submit`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret: "audit-body" }) });
  assert.strictEqual(submitted.response.status, 201);
  assert.strictEqual(submitted.json.body, '{"secret":"audit-body"}');
  await request(`http://127.0.0.1:${proxyPort}/one/large`);
  await request(`http://127.0.0.1:${proxyPort}/one/binary`);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.strictEqual((await api("/api/sites/default/audit-logs?limit=20", token)).total, 0);

  const tracked = await request(`http://127.0.0.1:${proxyPort}/__ih/track`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ site_id: "two", type: "pageview", page: "/welcome", data: { fingerprint: "site-two-visitor" } }) });
  assert.strictEqual(tracked.response.status, 200, tracked.text);
  const analyticsOne = await api("/api/sites/default/analytics/summary", token);
  const analyticsTwo = await api("/api/sites/two/analytics/summary", token);
  assert.strictEqual(analyticsOne.data.total_visitors, 0);
  assert.strictEqual(analyticsTwo.data.total_visitors, 1);

  const badClear = await request(apiUrl("/api/sites/default/audit-logs"), { method: "DELETE", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ confirm: "CLEAR no" }) });
  assert.strictEqual(badClear.response.status, 400);
  const cleared = await api("/api/sites/default/audit-logs", token, { method: "DELETE", body: JSON.stringify({ confirm: "CLEAR default" }) });
  assert.strictEqual(cleared.removed, 0);
  assert.strictEqual((await api("/api/sites/default/audit-logs", token)).total, 0);

  await api("/api/sites/default", token, { method: "PUT", body: JSON.stringify({ target_url: "https://127.0.0.1:1/" }) });
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
