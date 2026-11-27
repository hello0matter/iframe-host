const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ENV_NAME = /^[A-Z][A-Z0-9_]{0,79}$/;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  return Number.isInteger(n) ? Math.max(min, Math.min(n, max)) : fallback;
}

function normalizeSiteMonitor(raw, targetUrl) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const enabled = source.enabled === true;
  const urlPath = typeof source.path === 'string' && source.path.trim() ? source.path.trim() : '/';
  const mode = ['auto', 'regex', 'hash'].includes(source.mode) ? source.mode : 'auto';
  const pattern = typeof source.pattern === 'string' ? source.pattern.trim() : '';
  const tokenEnv = typeof source.pushplus_token_env === 'string' && source.pushplus_token_env.trim()
    ? source.pushplus_token_env.trim() : 'IH_PUSHPLUS_TOKEN';
  if (!urlPath.startsWith('/') || urlPath.startsWith('//') || urlPath.length > 2048 || /[\x00-\x1f\x7f]/.test(urlPath)) {
    throw new Error('monitor: path must be an absolute path on the original site');
  }
  if (enabled && mode === 'regex' && !pattern) throw new Error('monitor: regex pattern is required');
  if (pattern.length > 500) throw new Error('monitor: pattern is too long');
  if (pattern) {
    try { new RegExp(pattern); } catch (e) { throw new Error('monitor: invalid regex - ' + e.message); }
  }
  if (!ENV_NAME.test(tokenEnv)) throw new Error('monitor: invalid PushPlus token environment variable');
  let origin = '';
  try { origin = new URL(targetUrl).origin; } catch {}
  return {
    enabled,
    path: urlPath,
    mode,
    pattern,
    interval_seconds: clampInt(source.interval_seconds, 30, 86400, 300),
    timeout_seconds: clampInt(source.timeout_seconds, 5, 60, 15),
    notify_on_first_run: source.notify_on_first_run === true,
    notify_on_error: source.notify_on_error === true,
    include_assets: source.include_assets !== false,
    pushplus_token_env: tokenEnv,
    title_template: typeof source.title_template === 'string'
      ? source.title_template.slice(0, 120) : 'Original site changed: {site}',
    origin,
  };
}

function monitorFingerprint(body, contentType, monitor) {
  const text = String(body || '');
  let summary = [];
  let material = text;
  if (monitor.mode === 'regex') {
    const matches = text.match(new RegExp(monitor.pattern, 'g')) || [];
    summary = [...new Set(matches)].slice(0, 20);
    material = summary.join('\n') || 'NO_MATCH';
  } else if (monitor.mode === 'auto') {
    const title = (text.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
    const meta = [...text.matchAll(/<meta\b[^>]*(?:name|property)=["'](?:version|generator|application-name|og:site_name)["'][^>]*>/gi)]
      .map(match => match[0]).slice(0, 20);
    const assets = monitor.include_assets ? [
      ...text.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi),
      ...text.matchAll(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/gi),
    ].map(match => match[1]).filter(Boolean) : [];
    const versions = [...text.matchAll(/(?:data-version|data-build|content=["'][^"']*version[^"']*["'])[^>]{0,200}/gi)]
      .map(match => match[0]);
    summary = [...new Set([title.trim(), ...meta, ...assets, ...versions].filter(Boolean))].slice(0, 80);
    material = summary.join('\n') || text;
  }
  return {
    fingerprint: crypto.createHash('sha256').update(material).digest('hex'),
    summary,
    title: ((text.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').trim().slice(0, 200),
    bytes: Buffer.byteLength(text),
    content_type: String(contentType || '').slice(0, 120),
  };
}

function renderMonitorText(template, site, snapshot) {
  return String(template || 'Original site changed: {site}')
    .replaceAll('{site}', site.name || site.id)
    .replaceAll('{id}', site.id)
    .replaceAll('{url}', site.targetBase + (site.monitor?.path || '/'))
    .replaceAll('{fingerprint}', snapshot.fingerprint || '')
    .replaceAll('{time}', new Date(snapshot.checked_at || Date.now()).toISOString());
}

async function readLimitedText(response, limit) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      try { await reader.cancel(); } catch {}
      throw new Error('monitor: response is too large');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function sendPushPlus({ token, title, content, fetchImpl, timeoutMs = 12000 }) {
  if (!token) throw new Error('PUSHPLUS_TOKEN_MISSING');
  const response = await fetchImpl('https://www.pushplus.plus/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, title: title.slice(0, 100), content, template: 'txt' }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error('PUSHPLUS_HTTP_' + response.status);
  let result = null;
  try { result = await response.json(); } catch {}
  if (result && result.code !== undefined && Number(result.code) !== 200) {
    throw new Error('PUSHPLUS_REJECTED_' + result.code);
  }
  return result;
}

function createSiteMonitorService(options = {}) {
  const stateFile = path.resolve(options.stateFile || path.join(process.cwd(), 'site-monitor-state.json'));
  const getSites = options.getSites || (() => []);
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const now = options.now || Date.now;
  const sendPush = options.sendPush || sendPushPlus;
  const tickMs = options.tickMs || 15000;
  let state = null;
  let timer = null;
  let starting = false;
  const active = new Map();

  function emptyState() { return { version: 1, sites: {} }; }
  function load() {
    if (state) return state;
    try {
      const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      state = parsed && typeof parsed === 'object' ? parsed : emptyState();
      if (!state.sites || typeof state.sites !== 'object') state.sites = {};
    } catch { state = emptyState(); }
    return state;
  }
  function write() {
    const dir = path.dirname(stateFile);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = stateFile + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, stateFile);
  }
  function record(siteId) {
    load();
    if (!state.sites[siteId]) state.sites[siteId] = { history: [] };
    if (!Array.isArray(state.sites[siteId].history)) state.sites[siteId].history = [];
    return state.sites[siteId];
  }
  function siteById(siteId) { return getSites().find(site => site.id === siteId) || null; }
  function status(siteId) {
    const site = siteById(siteId);
    if (!site) return null;
    const row = record(siteId);
    const monitor = site.monitor || normalizeSiteMonitor(null, site.targetBase);
    return {
      site_id: siteId,
      enabled: monitor.enabled,
      path: monitor.path,
      mode: monitor.mode,
      interval_seconds: monitor.interval_seconds,
      token_env: monitor.pushplus_token_env,
      token_configured: Boolean(env[monitor.pushplus_token_env]),
      last: row.last || null,
      last_changed_at: row.last_changed_at || null,
      history: (row.history || []).slice(-10),
      next_check_at: row.last?.checked_at ? row.last.checked_at + monitor.interval_seconds * 1000 : null,
    };
  }
  async function notify(site, monitor, title, content) {
    const token = env[monitor.pushplus_token_env] || '';
    if (!token) return { sent: false, reason: 'token_not_configured' };
    try {
      await sendPush({ token, title, content, fetchImpl });
      return { sent: true };
    } catch (error) {
      return { sent: false, reason: error.message };
    }
  }
  async function check(siteId, { force = false } = {}) {
    if (active.has(siteId)) return active.get(siteId);
    const promise = (async () => {
      const site = siteById(siteId);
      if (!site) throw new Error('site not found');
      const monitor = site.monitor || normalizeSiteMonitor(null, site.targetBase);
      if (!monitor.enabled) throw new Error('monitor is disabled');
      const row = record(siteId);
      const last = row.last;
      if (!force && last?.checked_at && now() - last.checked_at < monitor.interval_seconds * 1000) {
        return { skipped: true, next_check_at: last.checked_at + monitor.interval_seconds * 1000 };
      }
      const url = new URL(monitor.path, site.targetBase);
      if (url.origin !== site.targetOrigin) throw new Error('monitor URL must stay on the original site');
      if (url.protocol !== 'https:') throw new Error('monitor URL must use HTTPS');
      let snapshot;
      try {
        const response = await fetchImpl(url.href, {
          method: 'GET',
          redirect: 'follow',
          headers: { accept: 'text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.5', 'user-agent': 'IframeHostMonitor/1.0' },
          signal: AbortSignal.timeout(monitor.timeout_seconds * 1000),
        });
        if (!response.ok) throw new Error('monitor HTTP ' + response.status);
        const body = await readLimitedText(response, MAX_BODY_BYTES);
        const fp = monitorFingerprint(body, response.headers.get('content-type'), monitor);
        snapshot = { ...fp, ok: true, status: response.status, etag: response.headers.get('etag') || '', last_modified: response.headers.get('last-modified') || '', checked_at: now() };
      } catch (error) {
        snapshot = { ok: false, error: error.message, checked_at: now(), fingerprint: last?.fingerprint || '', summary: [], title: '', bytes: 0, status: 0 };
        row.last = snapshot;
        row.history.push({ at: snapshot.checked_at, ok: false, error: snapshot.error });
        row.history = row.history.slice(-50);
        write();
        let notification = { sent: false, reason: 'not_requested' };
        if (monitor.notify_on_error) {
          notification = await notify(site, monitor, renderMonitorText(monitor.title_template, site, snapshot), `Site: ${site.name} (${site.id})\nURL: ${url.href}\nError: ${snapshot.error}\nTime: ${new Date(snapshot.checked_at).toISOString()}`);
        }
        return { ...status(siteId), notification };
      }
      const previous = last && last.ok ? last : null;
      const changed = Boolean(previous && previous.fingerprint !== snapshot.fingerprint);
      const first = !previous;
      snapshot.changed = changed;
      snapshot.previous_fingerprint = previous?.fingerprint || '';
      row.last = snapshot;
      if (changed || first) {
        if (changed) row.last_changed_at = snapshot.checked_at;
        row.history.push({ at: snapshot.checked_at, ok: true, changed, first, fingerprint: snapshot.fingerprint, previous_fingerprint: previous?.fingerprint || '', summary: snapshot.summary.slice(0, 20) });
        row.history = row.history.slice(-50);
      }
      write();
      let notification = { sent: false, reason: 'unchanged' };
      if ((changed || (first && monitor.notify_on_first_run))) {
        const title = renderMonitorText(monitor.title_template, site, snapshot);
        const oldItems = previous?.summary || [];
        const newItems = snapshot.summary || [];
        const added = newItems.filter(item => !oldItems.includes(item)).slice(0, 20);
        const removed = oldItems.filter(item => !newItems.includes(item)).slice(0, 20);
        const content = [
          `Site: ${site.name} (${site.id})`,
          `URL: ${url.href}`,
          `Time: ${new Date(snapshot.checked_at).toISOString()}`,
          `Fingerprint: ${snapshot.fingerprint}`,
          previous?.fingerprint ? `Previous: ${previous.fingerprint}` : 'Previous: none',
          added.length ? 'Added:\n' + added.join('\n') : '',
          removed.length ? 'Removed:\n' + removed.join('\n') : '',
        ].filter(Boolean).join('\n\n');
        notification = await notify(site, monitor, title, content);
        if (notification.sent) {
          row.last_notified_at = snapshot.checked_at;
          row.history.push({ at: snapshot.checked_at, ok: true, notification: 'sent' });
          row.history = row.history.slice(-50);
          write();
        }
      }
      return { ...status(siteId), notification, changed, first };
    })().finally(() => active.delete(siteId));
    active.set(siteId, promise);
    return promise;
  }
  async function testNotify(siteId) {
    const site = siteById(siteId);
    if (!site) throw new Error('site not found');
    const monitor = site.monitor || normalizeSiteMonitor(null, site.targetBase);
    const snapshot = record(siteId).last || { fingerprint: 'test', checked_at: now() };
    const result = await notify(site, monitor, '[Test] ' + renderMonitorText(monitor.title_template, site, snapshot), `PushPlus test for ${site.name} (${site.id}).\nTime: ${new Date().toISOString()}`);
    if (!result.sent) throw new Error(result.reason || 'notification failed');
    return result;
  }
  async function runDue() {
    if (starting) return;
    starting = true;
    try {
      for (const site of getSites()) {
        if (!site.enabled || !site.monitor?.enabled) continue;
        try { await check(site.id); } catch {}
      }
    } finally { starting = false; }
  }
  function start() {
    if (timer) return;
    timer = setInterval(() => { runDue().catch(() => {}); }, tickMs);
    if (timer.unref) timer.unref();
    const initial = setTimeout(() => { runDue().catch(() => {}); }, 5000);
    if (initial.unref) initial.unref();
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }
  function wake() { runDue().catch(() => {}); }
  return { status, check, testNotify, runDue, start, stop, wake };
}

module.exports = { normalizeSiteMonitor, monitorFingerprint, sendPushPlus, createSiteMonitorService };
