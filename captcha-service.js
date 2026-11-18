const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const COOKIE = 'ih_captcha_browser';
const TTL = 5 * 60 * 1000;
const CLIENT_EVENTS = new Set(['client_loaded', 'api_wrapped', 'api_missing', 'render_seen', 'widget_matched', 'sitekey_mismatch', 'page_mismatch', 'unsupported_widget', 'callback_missing', 'container_missing', 'ticket_expired', 'task_requested', 'task_processing', 'result_received', 'fields_written', 'original_callback_started', 'original_callback_done', 'original_callback_failed', 'extra_callback_started', 'extra_callback_done', 'extra_callback_failed', 'ready', 'service_failed', 'native_success', 'expired', 'reset', 'CAPTCHA_KEY_MISSING', 'CAPTCHA_HOURLY_LIMIT', 'CAPTCHA_BUSY', 'CAPTCHA_TIMEOUT', 'CAPTCHA_TICKET_INVALID', 'CAPTCHA_ADAPTER_INVALID', 'CAPTCHA_CALLBACK_FAILED', 'CAPTCHA_PROVIDER_REJECTED', 'CAPTCHA_PROVIDER_UNAVAILABLE', 'CAPTCHA_PROVIDER_BAD_RESPONSE', 'CAPTCHA_BUDGET_STORAGE_ERROR', 'CAPTCHA_DISABLED']);

class CaptchaError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}

function normalizeCaptcha(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('captcha: invalid configuration');
  const enabled = raw.enabled === true;
  const provider = raw.provider || '2captcha';
  const api_key_env = raw.api_key_env || 'CAPTCHA_2CAPTCHA_API_KEY';
  const site_key = typeof raw.site_key === 'string' ? raw.site_key.trim() : '';
  const page_path = raw.page_path || '/login';
  const timeout_seconds = Number(raw.timeout_seconds ?? 120);
  const max_tasks_per_hour = Number(raw.max_tasks_per_hour ?? 3);
  const mode = raw.mode ?? 'native_first';
  const response_selector = raw.response_selector ?? '';
  const response_field_name = raw.response_field_name ?? '';
  const callback_path = raw.callback_path ?? '';
  const result_ttl_seconds = Number(raw.result_ttl_seconds ?? 120);
  const messages = {};
  for (const field of ['waiting_message', 'ready_message']) {
    const value = raw[field] ?? '';
    if (typeof value !== 'string' || value.length > 200 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('captcha: invalid display message');
    messages[field] = value.trim();
  }
  if (provider !== '2captcha') throw new Error('captcha: unsupported provider');
  if (!/^[A-Z][A-Z0-9_]{0,79}$/.test(api_key_env)) throw new Error('captcha: invalid API key environment variable');
  if (site_key && !/^[A-Za-z0-9_-]{5,200}$/.test(site_key)) throw new Error('captcha: invalid site key');
  if (enabled && !site_key) throw new Error('captcha: site key is required');
  if (typeof page_path !== 'string' || !/^\/(?!\/)[A-Za-z0-9/_~.-]*$/.test(page_path) || page_path.split('/').some(p => p === '.' || p === '..')) throw new Error('captcha: invalid page path');
  if (!Number.isInteger(timeout_seconds) || timeout_seconds < 30 || timeout_seconds > 180) throw new Error('captcha: timeout must be 30-180 seconds');
  if (!Number.isInteger(max_tasks_per_hour) || max_tasks_per_hour < 1 || max_tasks_per_hour > 100) throw new Error('captcha: hourly limit must be 1-100');
  if (!['native_first', 'provider_only'].includes(mode)) throw new Error('captcha: invalid compatibility mode');
  if (typeof response_selector !== 'string' || response_selector.length > 500 || /[\x00-\x1f]/.test(response_selector)) throw new Error('captcha: invalid response selector');
  if (typeof response_field_name !== 'string' || (response_field_name && !/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/.test(response_field_name))) throw new Error('captcha: invalid response field name');
  if (typeof callback_path !== 'string' || (callback_path && (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(callback_path) || callback_path.length > 200 || callback_path.split('.').some(key => ['__proto__', 'prototype', 'constructor'].includes(key))))) throw new Error('captcha: invalid callback path');
  if (!Number.isInteger(result_ttl_seconds) || result_ttl_seconds < 30 || result_ttl_seconds > 240) throw new Error('captcha: result TTL must be 30-240 seconds');
  return { enabled, provider, api_key_env, site_key, page_path, timeout_seconds, max_tasks_per_hour, mode, response_selector, response_field_name, callback_path, result_ttl_seconds, ...messages };
}

function cookieValue(req) {
  const match = String(req.headers.cookie || '').match(/(?:^|;\s*)ih_captcha_browser=([a-f0-9]{48})(?:;|$)/);
  return match ? match[1] : '';
}

function createCaptchaService({ stateFile, fetchImpl = global.fetch, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), env = process.env, log = code => console.log('[captcha]', code) }) {
  const secret = crypto.randomBytes(32);
  const jobs = new Map();
  const active = new Set();
  const diagnosticEvents = [];
  const reports = new Map();
  const debugRates = new Map();
  function record(site, event, source = 'server', page = '') {
    if (!site.debugEnabled) return;
    const minute = Math.floor(now() / 60000);
    let rate = debugRates.get(site.id);
    if (!rate || rate.minute !== minute) {
      if (!debugRates.has(site.id) && debugRates.size >= 200) debugRates.delete(debugRates.keys().next().value);
      rate = { minute, count: 0 };
      debugRates.set(site.id, rate);
    }
    if (rate.count >= 120) return;
    rate.count++;
    const row = { at: new Date(now()).toISOString(), site: site.id, event, source, page };
    diagnosticEvents.push(row);
    if (diagnosticEvents.length > 1000) diagnosticEvents.shift();
    log(`site=${site.id} source=${source}${page ? ' page=' + page : ''} ${event}`);
  }
  let ledger = {};
  let storageHealthy = true;
  try {
    const data = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (!data || data.version !== 1 || !data.sites || typeof data.sites !== 'object' || Array.isArray(data.sites)) throw new Error('invalid state');
    for (const row of Object.values(data.sites)) {
      if (!row || !Number.isSafeInteger(row.hour) || !Number.isSafeInteger(row.count) || row.count < 0) throw new Error('invalid state');
    }
    ledger = data.sites;
  } catch (error) {
    if (error.code !== 'ENOENT') storageHealthy = false;
  }
  function digest(text) { return crypto.createHmac('sha256', secret).update(text).digest('hex'); }
  function fingerprint(site) {
    const verification = { ...site.captcha };
    delete verification.waiting_message;
    delete verification.ready_message;
    return digest(JSON.stringify([site.id, site.targetBase, verification]));
  }
  function cleanup() {
    for (const [ticket, job] of jobs) if (job.expires < now()) jobs.delete(ticket);
    for (const [key, value] of reports) if (value.expires < now()) reports.delete(key);
  }
  function issue(site, req, headers) {
    if (!site.captcha?.enabled) return null;
    cleanup();
    let browser = cookieValue(req);
    if (!browser) {
      browser = crypto.randomBytes(24).toString('hex');
      const secure = req.socket?.encrypted || req.headers['x-forwarded-proto'] === 'https';
      headers['set-cookie'] = [...(headers['set-cookie'] || []), `${COOKIE}=${browser}; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`];
    }
    const encoded = Buffer.from(JSON.stringify({ site: site.id, config: fingerprint(site), expires: now() + TTL, nonce: crypto.randomBytes(16).toString('hex'), browser: digest(browser) })).toString('base64url');
    return `${encoded}.${digest(encoded)}`;
  }
  function verify(ticket, site, req) {
    if (typeof ticket !== 'string' || ticket.length > 2000) throw new CaptchaError('CAPTCHA_TICKET_INVALID', 403);
    const [encoded, signature, extra] = ticket.split('.');
    if (!signature || extra || !/^[a-f0-9]{64}$/.test(signature) || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest(encoded)))) throw new CaptchaError('CAPTCHA_TICKET_INVALID', 403);
    let data;
    try { data = JSON.parse(Buffer.from(encoded, 'base64url').toString()); } catch { throw new CaptchaError('CAPTCHA_TICKET_INVALID', 403); }
    if (data.site !== site.id || data.config !== fingerprint(site) || data.expires <= now() || !cookieValue(req) || data.browser !== digest(cookieValue(req))) throw new CaptchaError('CAPTCHA_TICKET_INVALID', 403);
    return data;
  }
  function report(site, req, body) {
    if (!site?.debugEnabled) throw new CaptchaError('CAPTCHA_DIAGNOSTIC_DISABLED', 404);
    cleanup();
    if (!site?.enabled || !site.captcha?.enabled) throw new CaptchaError('CAPTCHA_DISABLED', 404);
    const ticket = verify(body?.ticket, site, req);
    if (!CLIENT_EVENTS.has(body?.event)) throw new CaptchaError('CAPTCHA_DIAGNOSTIC_INVALID');
    const key = digest(body.ticket);
    const entry = reports.get(key) || { count: 0, expires: ticket.expires };
    if (entry.count >= 48 || (!reports.has(key) && reports.size >= 200)) throw new CaptchaError('CAPTCHA_DIAGNOSTIC_LIMIT', 429);
    entry.count++;
    reports.set(key, entry);
    record(site, body.event, 'browser', key.slice(0, 12));
    return { ok: true };
  }
  function reserve(site) {
    if (!storageHealthy) throw new CaptchaError('CAPTCHA_BUDGET_STORAGE_ERROR', 503);
    const hour = Math.floor(now() / 3600000);
    const row = Object.hasOwn(ledger, site.id) && ledger[site.id].hour === hour ? ledger[site.id] : { hour, count: 0 };
    if (row.count >= site.captcha.max_tasks_per_hour) throw new CaptchaError('CAPTCHA_HOURLY_LIMIT', 429);
    const next = Object.fromEntries(Object.entries(ledger).filter(([, value]) => value.hour === hour));
    Object.defineProperty(next, site.id, { value: { hour, count: row.count + 1 }, enumerable: true });
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile + '.new', JSON.stringify({ version: 1, sites: next }), { mode: 0o600 });
      fs.renameSync(stateFile + '.new', stateFile);
      ledger = next;
    } catch { storageHealthy = false; throw new CaptchaError('CAPTCHA_BUDGET_STORAGE_ERROR', 503); }
  }
  async function providerCall(endpoint, body, deadline) {
    let response;
    try {
      response = await fetchImpl(`https://api.2captcha.com/${endpoint}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        signal: AbortSignal.timeout(Math.max(1, Math.min(15000, deadline - now()))), redirect: 'error',
      });
      if (!response.ok) throw new Error('http');
      const data = await response.json();
      if (data.errorId !== 0) throw new CaptchaError('CAPTCHA_PROVIDER_REJECTED', 502);
      return data;
    } catch (error) {
      if (error instanceof CaptchaError) throw error;
      throw new CaptchaError('CAPTCHA_PROVIDER_UNAVAILABLE', 502);
    }
  }
  async function solve(job, site, metadata, key) {
    const deadline = now() + site.captcha.timeout_seconds * 1000;
    try {
      const task = { type: 'TurnstileTaskProxyless', websiteURL: site.targetBase + site.captcha.page_path, websiteKey: site.captcha.site_key };
      if (metadata.action) task.action = metadata.action;
      const created = await providerCall('createTask', { clientKey: key, task }, deadline);
      if (!Number.isSafeInteger(created.taskId) || created.taskId <= 0) throw new CaptchaError('CAPTCHA_PROVIDER_BAD_RESPONSE', 502);
      record(site, 'task_started');
      while (now() < deadline) {
        await sleep(Math.min(5000, Math.max(0, deadline - now())));
        if (now() >= deadline) break;
        const result = await providerCall('getTaskResult', { clientKey: key, taskId: created.taskId }, deadline);
        if (now() >= deadline) break;
        if (result.status === 'processing') continue;
        if (result.status !== 'ready' || typeof result.solution?.token !== 'string' || !result.solution.token || result.solution.token.length > 16384) throw new CaptchaError('CAPTCHA_PROVIDER_BAD_RESPONSE', 502);
        job.status = 'ready'; job.token = result.solution.token;
        record(site, 'task_ready');
        return;
      }
      throw new CaptchaError('CAPTCHA_TIMEOUT', 504);
    } catch (error) {
      job.status = 'failed'; job.error = error instanceof CaptchaError ? error.code : 'CAPTCHA_INTERNAL_ERROR';
      record(site, job.error);
    } finally { active.delete(site.id); }
  }
  function request(site, req, body) {
    cleanup();
    if (!site?.enabled || !site.captcha?.enabled) throw new CaptchaError('CAPTCHA_DISABLED', 404);
    const data = verify(body?.ticket, site, req);
    const metadata = body?.metadata || {};
    if (metadata.sitekey !== site.captcha.site_key || metadata.cData || metadata.chlPageData || metadata.pagedata || (metadata.action && (typeof metadata.action !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(metadata.action)))) throw new CaptchaError('CAPTCHA_WIDGET_UNSUPPORTED');
    let job = jobs.get(body.ticket);
    if (!job) {
      const key = env[site.captcha.api_key_env];
      if (typeof key !== 'string' || !key.trim()) throw new CaptchaError('CAPTCHA_KEY_MISSING', 503);
      if (active.has(site.id)) throw new CaptchaError('CAPTCHA_BUSY', 429);
      if (jobs.size >= 200) throw new CaptchaError('CAPTCHA_BUSY', 429);
      reserve(site);
      job = { status: 'processing', expires: data.expires };
      jobs.set(body.ticket, job); active.add(site.id);
      void solve(job, site, metadata, key.trim());
    }
    return { status: job.status, ...(job.status === 'ready' ? { token: job.token } : {}), ...(job.error ? { error: job.error } : {}) };
  }
  function status(site) {
    const hour = Math.floor(now() / 3600000);
    return { enabled: site.captcha.enabled, mode: site.captcha.mode, debug_enabled: site.debugEnabled === true, recent_events: site.debugEnabled ? diagnosticEvents.filter(row => row.site === site.id).slice(-50).map(row => ({ ...row })) : [], key_configured: Boolean(env[site.captcha.api_key_env]?.trim()), storage_healthy: storageHealthy, active: active.has(site.id), tasks_this_hour: Object.hasOwn(ledger, site.id) && ledger[site.id].hour === hour ? ledger[site.id].count : 0, hourly_limit: site.captcha.max_tasks_per_hour };
  }
  return { issue, request, status, report };
}

function injectCaptcha(html, site, ticket) {
  if (!ticket) return html;
  const config = { messages: { waiting: site.captcha.waiting_message || '', ready: site.captcha.ready_message || '' }, debug: site.debugEnabled === true, site: site.id, sitekey: site.captcha.site_key, page: (site.proxyPrefix || '') + site.captcha.page_path, ticket, timeout: site.captcha.timeout_seconds, mode: site.captcha.mode, responseSelector: site.captcha.response_selector, responseFieldName: site.captcha.response_field_name, callbackPath: site.captcha.callback_path, resultTtl: site.captcha.result_ttl_seconds };
  const encoded = Buffer.from(JSON.stringify(config)).toString('base64url');
  const tag = `<script src="/__ih/captcha/client.js" data-captcha="${encoded}"></script>`;
  return /<head\b[^>]*>/i.test(html) ? html.replace(/<head\b[^>]*>/i, match => match + tag) : tag + html;
}

module.exports = { normalizeCaptcha, createCaptchaService, injectCaptcha, CaptchaError };
