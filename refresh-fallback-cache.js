#!/usr/bin/env node
"use strict";

const fs = require("fs");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = __dirname;
const target = new URL(process.env.FALLBACK_TARGET || "https://www.libaisec.com");
const output = path.resolve(process.env.FALLBACK_CACHE_OUTPUT || path.join(ROOT, ".cache", "fallback-cache.json"));
const seedPaths = (process.env.FALLBACK_CACHE_PATHS || "/,/a").split(",").map(value => value.trim()).filter(Boolean);
const maxOutputBytes = Math.max(0, Number(process.env.FALLBACK_CACHE_MAX_BYTES) || 0);
const port = 39000 + Math.floor(Math.random() * 1000);
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "iframe-host-cache-"));
const configPath = path.join(temporaryRoot, "config.json");
const visitorDataPath = path.join(temporaryRoot, "visitors.json");
const auditLogPath = path.join(temporaryRoot, "audit-logs");
let proxy;

function requestProxy(pathname) {
  return new Promise((resolve, reject) => {
    let deadline;
    const finish = (callback, value) => { clearTimeout(deadline); callback(value); };
    const request = http.get({ hostname: "127.0.0.1", port, path: pathname, headers: { "user-agent": "Mozilla/5.0 (compatible; iframe-host-cache-refresh/1.0)" } }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => finish(resolve, { status: response.statusCode, contentType: String(response.headers["content-type"] || "").toLowerCase(), body: Buffer.concat(chunks) }));
    });
    deadline = setTimeout(() => request.destroy(new Error(`proxy timeout ${pathname}`)), 18000);
    request.on("error", error => finish(reject, error));
  });
}

function requestTarget(pathname) {
  return new Promise((resolve, reject) => {
    const transport = target.protocol === "https:" ? https : http;
    let deadline;
    const finish = (callback, value) => { clearTimeout(deadline); callback(value); };
    const request = transport.get({
      hostname: target.hostname, port: target.port || undefined, path: pathname,
      headers: { "user-agent": "Mozilla/5.0 (compatible; iframe-host-cache-refresh/1.0)", "accept-encoding": "identity" },
    }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => finish(resolve, { status: response.statusCode, contentType: String(response.headers["content-type"] || "").toLowerCase(), contentEncoding: String(response.headers["content-encoding"] || "").toLowerCase(), body: Buffer.concat(chunks) }));
    });
    deadline = setTimeout(() => request.destroy(new Error(`source timeout ${pathname}`)), 3000);
    request.on("error", error => finish(reject, error));
  });
}

function queueResource(queue, scheduled, value, basePath) {
  if (!value || value.startsWith("data:") || value.startsWith("#")) return;
  let parsed;
  try { parsed = new URL(value, target.origin + basePath); } catch { return; }
  if (parsed.origin !== target.origin) return;
  const resource = parsed.pathname + parsed.search;
  if (!scheduled.has(resource) && scheduled.size < 24) {
    scheduled.add(resource);
    queue.push(resource);
  }
}

function findResources(body, contentType, basePath, queue, scheduled) {
  const text = body.toString("utf8");
  if (contentType.includes("text/html")) {
    for (const tag of text.match(/<link\b[^>]*>/gi) || []) {
      const rel = tag.match(/\brel\s*=\s*["']([^"']+)["']/i)?.[1] || "";
      const href = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
      if (href && /(?:stylesheet|icon)/i.test(rel)) queueResource(queue, scheduled, href, basePath);
    }
    for (const match of text.matchAll(/(?:src|data-src|poster)\s*=\s*["']([^"']+)["']/gi)) queueResource(queue, scheduled, match[1], basePath);
    for (const match of text.matchAll(/srcset\s*=\s*["']([^"']+)["']/gi)) {
      for (const source of match[1].split(",")) queueResource(queue, scheduled, source.trim().split(/\s+/, 1)[0], basePath);
    }
  }
  if (contentType.includes("text/html") || contentType.includes("text/css")) {
    for (const match of text.matchAll(/url\(\s*["']?([^'"()\s]+)["']?\s*\)/gi)) queueResource(queue, scheduled, match[1], basePath);
  }
}

function cacheStatic(cache, resource, response) {
  if (response.status < 200 || response.status >= 300 || response.body.length > 5 * 1024 * 1024) return false;
  const contentType = response.contentType;
  if (!/^(text\/(css|javascript)|application\/(javascript|x-javascript)|image\/|font\/|application\/(font-woff|x-font-ttf|vnd\.ms-fontobject))/i.test(contentType)) return false;
  const contentEncoding = /^(gzip|br|deflate)$/.test(response.contentEncoding) ? response.contentEncoding : "";
  const isText = !contentEncoding && /^(text\/|application\/(javascript|x-javascript))/i.test(contentType);
  const body = isText
    ? response.body.toString("utf8").replaceAll(target.origin, "").replaceAll(`//${target.host}`, "")
    : response.body.toString("base64");
  cache.entries[`default:${resource}`] = {
    content_type: contentType,
    ...(contentEncoding ? { content_encoding: contentEncoding } : {}),
    ...(isText ? { body } : { body, body_encoding: "base64" }),
    updated_at: Date.now(),
  };
  return true;
}

function trimCacheForOutput(cache) {
  if (!maxOutputBytes) return;
  const serializedSize = () => Buffer.byteLength(JSON.stringify(cache));
  const candidates = Object.entries(cache.entries).filter(([key, entry]) => key !== "default:/" && !String(entry.content_type || "").startsWith("text/") && !String(entry.content_type || "").includes("javascript"))
    .sort(([, left], [, right]) => Buffer.byteLength(right.body || "") - Buffer.byteLength(left.body || ""));
  while (serializedSize() > maxOutputBytes && candidates.length) delete cache.entries[candidates.shift()[0]];
  if (serializedSize() > maxOutputBytes) throw new Error(`cache cannot fit FALLBACK_CACHE_MAX_BYTES=${maxOutputBytes}`);
}

function cachedPages(cache) {
  return seedPaths.flatMap(resource => {
    const entry = cache.entries?.[`default:${resource}`];
    if (!entry || typeof entry.body !== "string" || !String(entry.content_type || "").includes("text/html")) return [];
    const body = entry.body_encoding === "base64" ? Buffer.from(entry.body, "base64") : Buffer.from(entry.body, "utf8");
    return [{ path: resource, response: { contentType: String(entry.content_type).toLowerCase(), body } }];
  });
}

async function stopProxy() {
  if (!proxy || proxy.exitCode !== null) return;
  await new Promise(resolve => {
    proxy.once("exit", resolve);
    proxy.kill("SIGTERM");
    setTimeout(resolve, 2000).unref();
  });
}

async function startProxyAndCachePages() {
  fs.writeFileSync(configPath, JSON.stringify({
    version: 2, port, bind_host: "127.0.0.1", admin_path: "cache-admin", admin_username: "cache", admin_password: "cache-refresh-only",
    audit_max_body_bytes: 1024,
    sites: [{ id: "default", name: "Fallback source", enabled: true, target_url: target.toString(), proxy_prefix: "", replace_rules: [], oauth_bypass_paths: [], rewrite_request_headers: true, audit_probe: { enabled: false } }],
  }));
  proxy = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, CONFIG_FILE: configPath, VISITOR_DATA_FILE: visitorDataPath, AUDIT_LOG_DIR: auditLogPath, FALLBACK_CACHE_FILE: output, UPSTREAM_TIMEOUT_MS: "15000" },
    stdio: ["ignore", "inherit", "inherit"],
  });
  let root;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      root = await requestProxy("/");
      if (root.status >= 200 && root.status < 300) break;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!root || root.status < 200 || root.status >= 300) throw new Error("unable to cache source homepage through iframe-host");
  const pages = [{ path: "/", response: root }];
  for (const resource of seedPaths.filter(value => value !== "/")) {
    try {
      const response = await requestProxy(resource);
      if (response.status >= 200 && response.status < 300) pages.push({ path: resource, response });
      else console.warn(`Skipped page ${resource}: HTTP ${response.status}`);
    } catch (error) {
      console.warn(`Skipped page ${resource}: ${error.message}`);
    }
  }
  await new Promise(resolve => setTimeout(resolve, 500));
  await stopProxy();
  return pages;
}

async function main() {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const reuseCachedPages = process.env.FALLBACK_CACHE_REUSE_PAGES === "1" && fs.existsSync(output);
  if (!reuseCachedPages) fs.rmSync(output, { force: true });
  let cache = reuseCachedPages ? JSON.parse(fs.readFileSync(output, "utf8")) : null;
  const pages = reuseCachedPages ? cachedPages(cache) : await startProxyAndCachePages();
  if (!pages.length) throw new Error("no cached HTML pages are available for static-resource refresh");
  cache ||= JSON.parse(fs.readFileSync(output, "utf8"));
  const queue = [];
  const scheduled = new Set();
  for (const page of pages) findResources(page.response.body, page.response.contentType, page.path, queue, scheduled);

  let cachedStatic = 0;
  async function worker() {
    while (queue.length) {
      const resource = queue.shift();
      try {
        const response = await requestTarget(resource);
        if (cacheStatic(cache, resource, response)) {
          cachedStatic++;
          findResources(response.body, response.contentType, resource, queue, scheduled);
        }
      } catch (error) {
        console.warn(`Skipped ${resource}: ${error.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: 10 }, worker));
  trimCacheForOutput(cache);
  fs.writeFileSync(output, JSON.stringify(cache));
  console.log(`Cached ${Object.keys(cache.entries || {}).length} resources (${cachedStatic} static): ${output}`);
}

main().catch(error => {
  console.error(`FAIL: ${error.stack || error.message}`);
  process.exitCode = 1;
}).finally(async () => {
  await stopProxy();
  fs.rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});
