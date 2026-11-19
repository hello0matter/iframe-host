const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Worker } = require('node:worker_threads');

class CallbackError extends Error {
  constructor(code, status = 400) { super(code); this.status = status; }
}
const fail = (code, status) => { throw new CallbackError(code, status); };
const clone = value => JSON.parse(JSON.stringify(value));
function normalizeCallback(raw) {
  if (raw !== undefined && (!raw || typeof raw !== 'object' || Array.isArray(raw))) fail('CALLBACK_CONFIG_INVALID');
  const v = raw || {};
  for (const key of ['enabled', 'auto_run', 'page_enabled']) if (v[key] !== undefined && typeof v[key] !== 'boolean') fail('CALLBACK_CONFIG_INVALID');
  const template_id = v.template_id || '';
  const signing_key_env = v.signing_key_env || 'IH_CALLBACK_SIGNING_KEY';
  if (typeof template_id !== 'string' || (template_id && !/^cb-[a-f0-9]{24}$/.test(template_id)) || typeof signing_key_env !== 'string' || !/^IH_CALLBACK_[A-Z0-9_]{1,80}$/.test(signing_key_env)) fail('CALLBACK_CONFIG_INVALID');
  if (v.enabled && !template_id) fail('CALLBACK_TEMPLATE_REQUIRED');
  return { enabled: v.enabled === true, template_id, signing_key_env, auto_run: v.auto_run === true, page_enabled: v.page_enabled === true };
}
function boundedJson(value, limit = 16384) {
  let text;
  try { text = JSON.stringify(value); } catch { fail('CALLBACK_JSON_INVALID'); }
  if (!text || Buffer.byteLength(text) > limit) fail('CALLBACK_DATA_TOO_LARGE');
  return JSON.parse(text);
}
function redact(value, depth = 0) {
  if (depth > 20) return '[depth limit]';
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(v => redact(v, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, /password|passwd|secret|token|authorization|cookie|api[-_]?key|signature|private[-_]?key/i.test(k) ? '[redacted]' : redact(v, depth + 1)]));
}
function normalizeDraft(raw) {
  const v = raw || {};
  if (typeof v.name !== 'string' || !v.name.trim() || v.name.length > 100 || typeof (v.description || '') !== 'string' || (v.description || '').length > 1000) fail('CALLBACK_TEMPLATE_INVALID');
  if (!Array.isArray(v.steps) || !v.steps.length || v.steps.length > 12) fail('CALLBACK_STEPS_INVALID');
  const steps = v.steps.map((s,i) => {
    if (!s || !['server_node','browser_js','page_refresh'].includes(s.type) || (s.type !== 'page_refresh' && (typeof s.code !== 'string' || !s.code.trim() || Buffer.byteLength(s.code) > 8192)) || (s.enabled !== undefined && typeof s.enabled !== 'boolean')) fail('CALLBACK_STEPS_INVALID');
    const timeout_ms = s.timeout_ms === undefined ? 1000 : s.timeout_ms;
    if (!Number.isInteger(timeout_ms) || timeout_ms < 100 || timeout_ms > 3000) fail('CALLBACK_STEPS_INVALID');
    return { name: String(s.name || 'Step ' + (i + 1)).slice(0,100), type: s.type, enabled: s.enabled !== false, timeout_ms, code: s.type === 'page_refresh' ? '' : s.code };
  });
  const ack_body = v.ack_body === undefined ? 'success' : v.ack_body;
  if (typeof ack_body !== 'string' || Buffer.byteLength(ack_body) > 1024) fail('CALLBACK_ACK_INVALID');
  return boundedJson({ name: v.name.trim(), description: v.description || '', steps, ack_body }, 64000);
}
function runBackend(step, context) {
  return new Promise((resolve,reject) => {
    const worker = new Worker(path.join(__dirname, 'callback-script-worker.js'), { workerData: { code: step.code, timeout_ms: step.timeout_ms, context }, env: {}, resourceLimits: { maxOldGenerationSizeMb: 64, stackSizeMb: 2 } });
    let done = false;
    const finish = (error,output) => {
      if (done) return; done = true; clearTimeout(timer); void worker.terminate();
      if (error) reject(new CallbackError(error)); else resolve(output);
    };
    const timer = setTimeout(() => finish('CALLBACK_SCRIPT_TIMEOUT'), step.timeout_ms + 3000);
    worker.once('message', result => finish(result.ok ? null : 'CALLBACK_SCRIPT_FAILED', result.output));
    worker.once('error', () => finish('CALLBACK_SCRIPT_FAILED'));
    worker.once('exit', code => { if (!done) finish('CALLBACK_SCRIPT_FAILED'); });
  });
}

function createCallbackService({ stateFile, getSite, env = process.env, now = Date.now, runner = runBackend, maxJobs = 200 } = {}) {
  let state = { version: 1, templates: [], jobs: [] };
  let healthy = true;
  let running = false;
  const pages = new Map();
  const pageWaiters = new Set();
  const pageTtl = 30 * 60 * 1000;
  try {
    if(fs.statSync(stateFile).size > 16 * 1024 * 1024) throw new Error();
    const data = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (data.version !== 1 || !Array.isArray(data.templates) || data.templates.length > 100 || !Array.isArray(data.jobs) || data.jobs.length > maxJobs) throw new Error();
    for (const t of data.templates) {
      if (!t || !/^cb-[a-f0-9]{24}$/.test(t.id)) throw new Error();
      normalizeDraft(t.draft);
      if(t.published) normalizeDraft(t.published);
    }
    for (const j of data.jobs) {
      if (!j || typeof j.id !== 'string' || typeof j.site_id !== 'string' || !Array.isArray(j.steps) || !Array.isArray(j.results) || !Number.isInteger(j.step) || j.step < 0 || j.step > j.steps.length || !['pending','running','waiting_browser','waiting_page','completed','failed','needs_review','manual_review'].includes(j.status)) throw new Error();
    }
    state = data;
  } catch (e) { if (e.code !== 'ENOENT') healthy = false; }
  function commit(change) {
    if (!healthy) fail('CALLBACK_STORAGE_UNAVAILABLE', 503);
    const next = clone(state);
    const result = change(next);
    const serialized = JSON.stringify(next);
    if (Buffer.byteLength(serialized) > 16 * 1024 * 1024) fail('CALLBACK_STORAGE_LIMIT',503);
    const temp = stateFile + '.next';
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      const fd = fs.openSync(temp, 'w', 0o600);
      try { fs.writeFileSync(fd, serialized); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.chmodSync(temp,0o600);
      fs.renameSync(temp,stateFile);
      if (process.platform !== 'win32') {
        const dir = fs.openSync(path.dirname(stateFile),'r');
        try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
      }
    } catch { healthy = false; fail('CALLBACK_STORAGE_UNAVAILABLE',503); }
    state = next;
    for (const notify of pageWaiters) setImmediate(notify);
    return clone(result === undefined ? null : result);
  }
  if (healthy && state.jobs.some(j => j.status === 'running' || j.status === 'waiting_page' || j.lease)) commit(next => {
    for (const j of next.jobs) {
      if (j.status === 'running' || j.status === 'waiting_page' || j.lease) { j.status = 'needs_review'; j.error = 'CALLBACK_INTERRUPTED'; delete j.lease; }
    }
  });
  const findTemplate = (id, data = state) => data.templates.find(t => t.id === id) || fail('CALLBACK_TEMPLATE_NOT_FOUND',404);
  const findJob = (id, data = state) => data.jobs.find(j => j.id === id) || fail('CALLBACK_JOB_NOT_FOUND',404);
  const safeJob = j => { const data = clone(j); delete data.lease; delete data.digest; return data; };
  function list() {
    expirePageJobs();
    if (!healthy) fail('CALLBACK_STORAGE_UNAVAILABLE',503);
    return { running, active_page_count: state.jobs.filter(j => j.status === 'waiting_page').length, active_browser_count: state.jobs.filter(j => j.lease && j.lease.expires_at >= now()).length, templates: clone(state.templates), jobs: state.jobs.slice(-100).reverse().map(j => ({ id: j.id, site_id: j.site_id, template_id: j.template_id, version: j.version, status: j.status, step: j.step, event_id: j.event_id, created_at: j.created_at, error: j.error || '' })), storage_healthy: healthy };
  }
  function save(id, raw) {
    const draft = normalizeDraft(raw);
    return commit(next => {
      if (id) { const t = findTemplate(id,next); if (t.archived) fail('CALLBACK_TEMPLATE_ARCHIVED',409); t.draft = draft; t.updated_at = now(); return t; }
      if (next.templates.length >= 100) fail('CALLBACK_TEMPLATE_LIMIT',409);
      const t = { id: 'cb-' + crypto.randomBytes(12).toString('hex'), draft, published: null, archived: false, enabled: false, created_at: now(), updated_at: now() };
      next.templates.push(t); return t;
    });
  }
  function publish(id) {
    const result = commit(next => {
      const t = findTemplate(id,next);
      if (t.archived) fail('CALLBACK_TEMPLATE_ARCHIVED',409);
      t.published = { ...normalizeDraft(t.draft), version: (t.published?.version || 0) + 1, published_at: now() };
      t.enabled = true;
      return t;
    });
    schedule();
    return result;
  }
  function toggle(id,enabled) {
    if (typeof enabled !== 'boolean') fail('CALLBACK_CONFIG_INVALID');
    const result = commit(next => { const t = findTemplate(id,next); if (enabled && (!t.published || t.archived)) fail('CALLBACK_NOT_PUBLISHED',409); t.enabled = enabled; return t; });
    if(enabled) schedule();
    return result;
  }
  function remove(id, bindings = []) {
    if (bindings.includes(id)) fail('CALLBACK_TEMPLATE_IN_USE',409);
    return commit(next => {
      const t = findTemplate(id,next);
      if (next.jobs.some(j => j.template_id === id)) { t.archived = true; t.enabled = false; return { archived: true }; }
      next.templates = next.templates.filter(t => t.id !== id); return { archived: false };
    });
  }
  function receive(siteId, rawBody, headers) {
    if (!healthy) fail('CALLBACK_STORAGE_UNAVAILABLE',503);
    const site = getSite(siteId);
    const binding = site?.externalCallback;
    if (!site?.enabled || !binding?.enabled) fail('CALLBACK_DISABLED',404);
    const key = env[binding.signing_key_env];
    if (typeof key !== 'string' || Buffer.byteLength(key) < 32) fail('CALLBACK_SIGNING_KEY_MISSING',503);
    const timestamp = headers['x-ih-timestamp'];
    const signature = headers['x-ih-signature'];
    if (typeof timestamp !== 'string' || !/^\d{10}$/.test(timestamp) || Math.abs(now() / 1000 - Number(timestamp)) > 300 || typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature)) fail('CALLBACK_SIGNATURE_INVALID',401);
    const expected = crypto.createHmac('sha256',key).update(timestamp + '.' + siteId + '.').update(rawBody).digest();
    if (!crypto.timingSafeEqual(expected, Buffer.from(signature,'hex'))) fail('CALLBACK_SIGNATURE_INVALID',401);
    let event;
    try { event = JSON.parse(rawBody.toString('utf8')); } catch { fail('CALLBACK_JSON_INVALID'); }
    if (!event || Array.isArray(event) || typeof event !== 'object' || typeof event.event_id !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(event.event_id)) fail('CALLBACK_EVENT_ID_INVALID');
    const digest = crypto.createHash('sha256').update(rawBody).digest('hex');
    const existing = state.jobs.find(j => j.site_id === siteId && j.event_id === event.event_id);
    if (existing) {
      if (existing.digest !== digest) fail('CALLBACK_EVENT_CONFLICT',409);
      return { job_id: existing.id, duplicate: true, ack_body: existing.ack_body };
    }
    const t = findTemplate(binding.template_id);
    if (!t.published || t.archived) fail('CALLBACK_NOT_PUBLISHED',409);
    if (state.jobs.length >= maxJobs) fail('CALLBACK_JOB_LIMIT',503);
    const input = redact(boundedJson(event));
    const job = commit(next => {
      const j = { id: crypto.randomUUID(), site_id: siteId, template_id: t.id, version: t.published.version, steps: clone(t.published.steps), ack_body: t.published.ack_body, event_id: event.event_id, digest, event: input, input, results: [], step: 0, status: 'pending', created_at: now(), updated_at: now(), source: 'signed_external', payment_verified: false };
      next.jobs.push(j); return j;
    });
    if (binding.auto_run) schedule();
    return { job_id: job.id, duplicate: false, ack_body: job.ack_body };
  }
  function context(j) { return boundedJson({ input: j.input, event: j.event, previous: j.results.map(r => ({ step: r.step, type: r.type, output: r.output, trusted: r.type !== 'browser_js' })) }, 65536); }
  function patchJob(id,change) { return commit(next => { const j = findJob(id,next); change(j); j.updated_at = now(); return j; }); }
  function executionSite(j) {
    const site = getSite(j.site_id);
    const t = findTemplate(j.template_id);
    if (!site?.enabled || (j.source !== 'admin_test' && (!site.externalCallback?.enabled || site.externalCallback.template_id !== j.template_id)) || !t.enabled || t.archived) fail('CALLBACK_EXECUTION_PAUSED',409);
  }
  async function run(id) {
    const initial = findJob(id);
    executionSite(initial);
    if (running) fail('CALLBACK_BUSY',409);
    if (!['pending','waiting_browser'].includes(initial.status) || initial.lease) fail('CALLBACK_JOB_NOT_RUNNABLE',409);
    running = true;
    try {
      for (;;) {
        const j = findJob(id); executionSite(j);
        if (j.step >= j.steps.length) { patchJob(id,v => { v.status = 'completed'; }); return safeJob(findJob(id)); }
        const step = j.steps[j.step];
        if (!step.enabled) { patchJob(id,v => { v.step++; }); continue; }
        if (step.type === 'browser_js') { patchJob(id,v => { v.status = 'waiting_browser'; }); return safeJob(findJob(id)); }
        if (step.type === 'page_refresh') {
          const site = getSite(j.site_id);
          if (!site.externalCallback?.page_enabled) {
            patchJob(id,v => { v.status = 'failed'; v.error = 'CALLBACK_PAGE_DISABLED'; });
            return safeJob(findJob(id));
          }
          const page = pages.get(j.event?.page_ref);
          if (!page || page.site_id !== j.site_id || page.order_ref !== j.event?.order_ref || page.expires_at <= now()) {
            patchJob(id,v => { v.status = 'failed'; v.error = 'CALLBACK_PAGE_BINDING_INVALID'; });
            return safeJob(findJob(id));
          }
          patchJob(id,v => { v.status = 'waiting_page'; v.page_deadline = page.expires_at; });
          return safeJob(findJob(id));
        }
        patchJob(id,v => { v.status = 'running'; });
        try {
          const output = redact(boundedJson(await runner(step,context(j))));
          patchJob(id,v => { v.results.push({ step: v.step, type: step.type, output }); v.input = output; v.step++; v.status = 'pending'; });
        } catch (e) {
          patchJob(id,v => { v.status = 'failed'; v.error = e instanceof CallbackError ? e.message : 'CALLBACK_SCRIPT_FAILED'; });
          return safeJob(findJob(id));
        }
      }
    } finally { running = false; schedule(); }
  }
  function schedule() {
    setImmediate(() => {
      if (running || !healthy) return;
      const j = state.jobs.find(j => {
        const site = getSite(j.site_id); const t = state.templates.find(t => t.id === j.template_id);
        return j.source !== 'admin_test' && j.status === 'pending' && site?.enabled && site.externalCallback?.enabled && site.externalCallback.template_id === j.template_id && site.externalCallback.auto_run && t?.enabled && !t.archived;
      });
      if (j) void run(j.id).catch(() => {});
    });
  }
  function test(id, siteId, event = {}) {
    if (!getSite(siteId)?.enabled) fail('CALLBACK_SITE_NOT_FOUND',404);
    const t = findTemplate(id);
    if (!t.published || t.archived) fail('CALLBACK_NOT_PUBLISHED',409);
    const input = redact(boundedJson(event));
    return commit(next => {
      if (next.jobs.length >= maxJobs) fail('CALLBACK_JOB_LIMIT',503);
      const j = { id: crypto.randomUUID(), site_id: siteId, template_id: id, version: t.published.version, steps: clone(t.published.steps), ack_body: t.published.ack_body, event_id: 'test:' + crypto.randomUUID(), event: input, input, results: [], step: 0, status: 'pending', created_at: now(), updated_at: now(), source: 'admin_test', payment_verified: false };
      next.jobs.push(j); return safeJob(j);
    });
  }
  function browserStep(id) {
    const j = findJob(id); executionSite(j);
    if (running || j.status !== 'waiting_browser' || j.steps[j.step]?.type !== 'browser_js' || j.lease) fail('CALLBACK_BROWSER_NOT_READY',409);
    const token = crypto.randomBytes(24).toString('hex');
    patchJob(id,v => { v.lease = { hash: crypto.createHash('sha256').update(token).digest('hex'), expires_at: now() + 60000 }; });
    return { token, context: context(j), code: j.steps[j.step].code, timeout_ms: j.steps[j.step].timeout_ms };
  }
  function browserResult(id,body) {
    const j = findJob(id); executionSite(j);
    if (j.status !== 'waiting_browser' || !j.lease || j.lease.expires_at < now() || typeof body.token !== 'string' || crypto.createHash('sha256').update(body.token).digest('hex') !== j.lease.hash) fail('CALLBACK_BROWSER_LEASE_INVALID',409);
    const output = redact(boundedJson(body.output === undefined ? null : body.output));
    patchJob(id,v => {
      delete v.lease;
      if (body.ok !== true) { v.status = 'failed'; v.error = 'CALLBACK_BROWSER_FAILED'; return; }
      v.results.push({ step: v.step, type: 'browser_js', output, trusted: false }); v.input = output; v.step++; v.status = 'pending';
    });
    return safeJob(findJob(id));
  }
  function bindingStatus(id) {
    const site = getSite(id); if (!site) fail('CALLBACK_SITE_NOT_FOUND',404);
    const binding = site.externalCallback || normalizeCallback();
    const t = state.templates.find(t => t.id === binding.template_id);
    return { ...binding, key_configured: typeof env[binding.signing_key_env] === 'string' && Buffer.byteLength(env[binding.signing_key_env]) >= 32, published_version: t?.published?.version || 0, template_enabled: t?.enabled === true && !t.archived, storage_healthy: healthy };
  }
  function pageSite(siteId) {
    const site = getSite(siteId);
    if (!site?.enabled || !site.externalCallback?.page_enabled) fail('CALLBACK_PAGE_DISABLED',404);
    return site;
  }
  function prunePages() {
    for (const [id,p] of pages) if (p.expires_at <= now()) pages.delete(id);
  }
  function expirePageJobs() {
    if (healthy && state.jobs.some(j => j.status === 'waiting_page' && j.page_deadline <= now())) commit(next => {
      for (const j of next.jobs) if (j.status === 'waiting_page' && j.page_deadline <= now()) { j.status = 'failed'; j.error = 'CALLBACK_PAGE_EXPIRED'; }
    });
  }
  function registerPage(siteId, body) {
    const site = pageSite(siteId);
    prunePages();
    if (typeof body.order_ref !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(body.order_ref) || typeof body.path !== 'string') fail('CALLBACK_PAGE_BINDING_INVALID');
    let url;
    try { url = new URL(body.path,'https://page.invalid'); } catch { fail('CALLBACK_PAGE_BINDING_INVALID'); }
    const prefix = site.proxyPrefix || '';
    if (url.origin !== 'https://page.invalid' || url.pathname !== body.path || (prefix && url.pathname !== prefix && !url.pathname.startsWith(prefix + '/')) || /^\/(?:__ih|admin|internal-content-admin)(?:\/|$)/.test(url.pathname)) fail('CALLBACK_PAGE_BINDING_INVALID');
    if (pages.size >= 200) fail('CALLBACK_PAGE_LIMIT',503);
    const page_ref = crypto.randomBytes(24).toString('hex');
    const secret = crypto.randomBytes(32).toString('hex');
    const expires_at = now() + pageTtl;
    pages.set(page_ref,{site_id:siteId,order_ref:body.order_ref,path:body.path,secret_hash:crypto.createHash('sha256').update(secret).digest(),expires_at,busy:false});
    return {page_ref,secret,expires_at};
  }
  function authenticatedPage(siteId, body) {
    pageSite(siteId); prunePages();
    const p = pages.get(body.page_ref);
    const hash = crypto.createHash('sha256').update(typeof body.secret === 'string' ? body.secret : '').digest();
    if (!p || p.site_id !== siteId || typeof body.secret !== 'string' || !crypto.timingSafeEqual(hash,p.secret_hash)) fail('CALLBACK_PAGE_SESSION_INVALID',401);
    return p;
  }
  function pageCommand(siteId, body) {
    expirePageJobs();
    const p = authenticatedPage(siteId,body);
    for (const j of state.jobs) {
      if (j.status !== 'waiting_page' || j.site_id !== siteId || j.event?.page_ref !== body.page_ref || j.event?.order_ref !== p.order_ref) continue;
      try { executionSite(j); } catch { continue; }
      if (j.page_deadline <= now()) continue;
      return {job_id:j.id,step:j.step,action:'reload',path:p.path};
    }
    return null;
  }
  function pollPage(siteId, body, signal, timeout = 20000) {
    const p = authenticatedPage(siteId,body);
    if (p.busy) fail('CALLBACK_PAGE_BUSY',409);
    if (!healthy) fail('CALLBACK_STORAGE_UNAVAILABLE',503);
    p.busy = true;
    return new Promise((resolve,reject) => {
      let done = false;
      const finish = (error,result) => {
        if (done) return; done = true; p.busy = false;
        clearTimeout(timer); pageWaiters.delete(check); signal?.removeEventListener('abort',abort);
        if (error) reject(error); else resolve(result);
      };
      const check = () => { try { const cmd = pageCommand(siteId,body); if (cmd) finish(null,cmd); } catch(e) { finish(e); } };
      const abort = () => finish(null,null);
      const timer = setTimeout(() => { try { finish(null,pageCommand(siteId,body)); } catch(e) { finish(e); } },timeout);
      pageWaiters.add(check); signal?.addEventListener('abort',abort,{once:true});
      if (signal?.aborted) abort(); else check();
    });
  }
  function acknowledgePage(siteId,body) {
    const cmd = pageCommand(siteId,body);
    if (!cmd || cmd.job_id !== body.job_id || cmd.step !== body.step) fail('CALLBACK_PAGE_COMMAND_INVALID',409);
    patchJob(cmd.job_id,j => {
      j.results.push({step:j.step,type:'page_refresh',output:{notification_acknowledged:true},trusted:false});
      j.step++; j.status = 'pending'; delete j.page_deadline;
    });
    pages.delete(body.page_ref);
    schedule();
    return {ok:true};
  }
  function review(id) { return patchJob(id,j => { if (j.status === 'running') fail('CALLBACK_BUSY',409); j.status = 'manual_review'; delete j.lease; }); }
  schedule();
  return { list, save, publish, toggle, remove, receive, run, test, bindingStatus, registerPage, pollPage, acknowledgePage, wake: schedule, browserStep, browserResult, review, job: id => safeJob(findJob(id)), status: () => ({ storage_healthy: healthy, running }) };
}

module.exports = { normalizeCallback, normalizeDraft, CallbackError, createCallbackService, runBackend };
