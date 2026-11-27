const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { normalizePaymentIntent } = require('./payment-adapters');

const ENV_NAME = /^[A-Z][A-Z0-9_]{0,79}$/;
const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/;
const EXECUTIONS = new Set(['qr_display', 'qr_open_device', 'browser_assist', 'api_call', 'notification_settle']);

class PaymentError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = 'PaymentError';
    this.code = code;
    this.status = status;
  }
}

function normalizePaymentConfig(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const adapter = ['generic', 'xp_pay', 'vmq'].includes(source.adapter) ? source.adapter : 'generic';
  const captureMode = source.capture_match_mode === 'literal' ? 'literal' : 'regex';
  const capturePattern = typeof source.capture_url_pattern === 'string' && source.capture_url_pattern.trim()
    ? source.capture_url_pattern.trim()
    : '^/api/v1/payment/orders(?:[?#]|$)';
  if (capturePattern.length > 500) throw new Error('payment: capture pattern is too long');
  if (captureMode === 'regex') {
    try { new RegExp(capturePattern); } catch (e) { throw new Error('payment: invalid capture regex - ' + e.message); }
  }
  const execution = EXECUTIONS.has(source.default_execution) ? source.default_execution : 'qr_display';
  const deviceTokenEnv = typeof source.device_token_env === 'string' && source.device_token_env.trim()
    ? source.device_token_env.trim() : 'IH_DEVICE_AGENT_TOKEN';
  if (!ENV_NAME.test(deviceTokenEnv)) throw new Error('payment: invalid device token environment variable');
  const deviceId = typeof source.device_id === 'string' ? source.device_id.trim() : '';
  if (deviceId && !DEVICE_ID.test(deviceId)) throw new Error('payment: invalid device id');
  const defaults = adapter === 'xp_pay'
    ? { order_ref: 'out_trade_no', amount: 'pay_amount', qr_content: 'pay_url', expires_at: 'expires_at', channel: 'payment_type', currency: 'currency' }
    : adapter === 'vmq'
      ? { order_ref: 'orderId', amount: 'reallyPrice', qr_content: 'payUrl', expires_at: 'expiresAt', channel: 'type', currency: 'currency' }
      : { order_ref: 'order_ref', amount: 'amount', qr_content: 'qr_content', expires_at: 'expires_at', channel: 'channel', currency: 'currency' };
  const fieldMap = { ...defaults };
  if (source.field_map && typeof source.field_map === 'object' && !Array.isArray(source.field_map)) {
    for (const key of Object.keys(defaults)) {
      const value = source.field_map[key];
      if (typeof value === 'string' && value.trim()) fieldMap[key] = value.trim().slice(0, 200);
    }
  }
  return {
    enabled: source.enabled === true,
    adapter,
    capture_enabled: source.capture_enabled === true,
    capture_url_pattern: capturePattern,
    capture_match_mode: captureMode,
    field_map: fieldMap,
    require_user_approval: source.require_user_approval !== false,
    auto_dispatch: source.auto_dispatch === true,
    default_execution: execution,
    device_id: deviceId,
    device_token_env: deviceTokenEnv,
  };
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function nowIso(now) { return new Date(now()).toISOString(); }
function amountMatches(a, b) { return Number(a).toFixed(2) === Number(b).toFixed(2); }

function createPaymentService(options = {}) {
  const stateFile = path.resolve(options.stateFile || path.join(process.cwd(), 'payment-state.json'));
  const getSites = options.getSites || (() => []);
  const env = options.env || process.env;
  const now = options.now || Date.now;
  let state = null;

  function emptyState() { return { version: 1, intents: [], tasks: [], devices: [] }; }
  function load() {
    if (state) return state;
    try {
      const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      state = parsed && typeof parsed === 'object' ? parsed : emptyState();
    } catch { state = emptyState(); }
    for (const key of ['intents', 'tasks', 'devices']) if (!Array.isArray(state[key])) state[key] = [];
    return state;
  }
  function write() {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
    const tmp = stateFile + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, stateFile);
  }
  function siteById(siteId) { return getSites().find(site => site.id === siteId) || null; }
  function sitePayment(site) { return site.payment || normalizePaymentConfig(null); }
  function event(intent, type, data = {}) {
    intent.events = Array.isArray(intent.events) ? intent.events : [];
    intent.events.push({ at: nowIso(now), type, ...data });
    intent.events = intent.events.slice(-50);
    intent.updated_at = nowIso(now);
  }
  function prune() {
    load();
    state.intents = state.intents.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))).slice(0, 500);
    state.tasks = state.tasks.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 500);
    state.devices = state.devices.sort((a, b) => String(b.last_seen_at || '').localeCompare(String(a.last_seen_at || ''))).slice(0, 100);
  }
  function expire(intent) {
    if (intent.expires_at && intent.expires_at <= now() && !['settled', 'fulfilled', 'cancelled', 'expired'].includes(intent.status)) {
      intent.status = 'expired';
      event(intent, 'expired');
    }
    return intent;
  }
  function findIntent(id) {
    load();
    const intent = state.intents.find(row => row.id === id);
    if (!intent) throw new PaymentError('PAYMENT_INTENT_NOT_FOUND', 404);
    return expire(intent);
  }
  function listIntents(siteId, limit = 100) {
    load();
    return state.intents
      .filter(intent => !siteId || intent.site_id === siteId)
      .map(expire)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, Math.max(1, Math.min(Number(limit) || 100, 500)));
  }
  function makeTask(intent, site, execution, deviceId) {
    const task = {
      id: crypto.randomUUID(),
      intent_id: intent.id,
      site_id: intent.site_id,
      device_id: deviceId || '',
      action: 'open_payment_qr',
      status: 'queued',
      attempts: 0,
      created_at: nowIso(now),
      leased_at: null,
      completed_at: null,
      payload: {
        provider: intent.provider,
        kind: intent.kind,
        channel: intent.channel,
        qr_content: intent.qr_content,
        qr_image_url: intent.qr_image_url,
        pay_url: intent.pay_url,
        amount: intent.amount,
        currency: intent.currency,
        order_ref: intent.order_ref,
        expires_at: intent.expires_at,
        execution,
        site_name: site.name,
      },
    };
    state.tasks.unshift(task);
    return task;
  }
  function dispatchIntent(intent, options = {}) {
    const site = siteById(intent.site_id);
    if (!site) throw new PaymentError('PAYMENT_SITE_NOT_FOUND', 404);
    const config = sitePayment(site);
    const execution = EXECUTIONS.has(options.execution) ? options.execution : intent.execution || config.default_execution;
    if (!EXECUTIONS.has(execution)) throw new PaymentError('PAYMENT_EXECUTION_INVALID');
    if (!['normalized', 'awaiting_user_approval', 'needs_review'].includes(intent.status)) throw new PaymentError('PAYMENT_INTENT_NOT_DISPATCHABLE', 409);
    intent.execution = execution;
    if (execution === 'qr_open_device') {
      const deviceId = String(options.device_id || config.device_id || '').trim();
      if (deviceId && !DEVICE_ID.test(deviceId)) throw new PaymentError('PAYMENT_DEVICE_INVALID');
      const task = makeTask(intent, site, execution, deviceId);
      intent.task_id = task.id;
      intent.status = 'dispatched';
      event(intent, 'dispatched', { execution, task_id: task.id, device_id: deviceId });
    } else if (execution === 'qr_display' || execution === 'browser_assist' || execution === 'notification_settle') {
      intent.status = 'waiting_settlement';
      event(intent, 'dispatched', { execution });
    } else {
      throw new PaymentError('PAYMENT_EXECUTION_UNAVAILABLE', 409);
    }
    intent.updated_at = nowIso(now);
    write();
    return clone(intent);
  }
  function createIntent(siteId, input, options = {}) {
    load();
    const site = siteById(siteId);
    if (!site) throw new PaymentError('PAYMENT_SITE_NOT_FOUND', 404);
    const config = sitePayment(site);
    if (!config.enabled) throw new PaymentError('PAYMENT_DISABLED', 409);
    const normalized = normalizePaymentIntent(input, site);
    const existing = state.intents.find(intent => intent.site_id === siteId && intent.order_ref === normalized.order_ref && !['failed', 'cancelled', 'expired'].includes(intent.status));
    if (existing) return { intent: clone(expire(existing)), duplicate: true };
    const intent = {
      id: crypto.randomUUID(),
      site_id: siteId,
      status: config.require_user_approval ? 'awaiting_user_approval' : 'normalized',
      execution: config.default_execution,
      requires_user_approval: config.require_user_approval,
      source: options.source || 'admin',
      ...normalized,
      events: [],
      created_at: nowIso(now),
      updated_at: nowIso(now),
      settled_at: null,
      fulfilled_at: null,
    };
    event(intent, 'detected', { source: intent.source });
    event(intent, 'normalized', { adapter: normalized.adapter });
    state.intents.unshift(intent);
    if (!config.require_user_approval && config.auto_dispatch) {
      try { dispatchIntent(intent, {}); } catch {}
    }
    prune();
    write();
    return { intent: clone(intent), duplicate: false };
  }
  function settleIntent(id, payload = {}) {
    load();
    const intent = findIntent(id);
    const orderRef = String(payload.order_ref || '').trim();
    const amount = payload.amount === undefined ? null : Number(payload.amount);
    if (!orderRef || !amountMatches(amount, intent.amount)) {
      intent.status = 'needs_review';
      event(intent, 'settlement_mismatch', { order_ref: orderRef, amount: payload.amount ?? null });
      write();
      throw new PaymentError('PAYMENT_SETTLEMENT_MISMATCH', 409);
    }
    if (orderRef !== intent.order_ref) {
      intent.status = 'needs_review';
      event(intent, 'settlement_order_mismatch', { order_ref: orderRef });
      write();
      throw new PaymentError('PAYMENT_SETTLEMENT_ORDER_MISMATCH', 409);
    }
    if (!['dispatched', 'waiting_settlement', 'needs_review'].includes(intent.status)) throw new PaymentError('PAYMENT_INTENT_NOT_SETTLEABLE', 409);
    intent.status = 'settled';
    intent.settled_at = nowIso(now);
    intent.settlement = { order_ref: orderRef, amount: Number(amount).toFixed(2), source: String(payload.source || 'manual').slice(0, 80), evidence: String(payload.evidence || '').slice(0, 2000) };
    event(intent, 'settled', { order_ref: orderRef, amount: Number(amount).toFixed(2) });
    write();
    return clone(intent);
  }
  function fulfillIntent(id, payload = {}) {
    load();
    const intent = findIntent(id);
    if (intent.status !== 'settled') throw new PaymentError('PAYMENT_INTENT_NOT_SETTLED', 409);
    intent.status = 'fulfilled';
    intent.fulfilled_at = nowIso(now);
    intent.fulfillment = { result: String(payload.result || 'ok').slice(0, 2000), reference: String(payload.reference || '').slice(0, 200) };
    event(intent, 'fulfilled', { reference: intent.fulfillment.reference });
    write();
    return clone(intent);
  }
  function cancelIntent(id) {
    load();
    const intent = findIntent(id);
    if (['settled', 'fulfilled', 'cancelled'].includes(intent.status)) throw new PaymentError('PAYMENT_INTENT_NOT_CANCELLABLE', 409);
    intent.status = 'cancelled';
    event(intent, 'cancelled');
    state.tasks.filter(task => task.intent_id === intent.id && task.status === 'queued').forEach(task => { task.status = 'cancelled'; task.completed_at = nowIso(now); });
    write();
    return clone(intent);
  }
  function registerDevice(input = {}) {
    load();
    const deviceId = String(input.device_id || '').trim();
    if (!DEVICE_ID.test(deviceId)) throw new PaymentError('PAYMENT_DEVICE_INVALID');
    let device = state.devices.find(row => row.id === deviceId);
    if (!device) {
      device = { id: deviceId, name: String(input.name || deviceId).slice(0, 120), capabilities: [], created_at: nowIso(now) };
      state.devices.unshift(device);
    }
    device.name = String(input.name || device.name || deviceId).slice(0, 120);
    device.capabilities = Array.isArray(input.capabilities) ? input.capabilities.filter(value => typeof value === 'string').slice(0, 20) : device.capabilities;
    device.last_seen_at = nowIso(now);
    prune();
    write();
    return clone(device);
  }
  function nextTask(deviceId) {
    load();
    if (!DEVICE_ID.test(deviceId)) throw new PaymentError('PAYMENT_DEVICE_INVALID');
    const device = state.devices.find(row => row.id === deviceId);
    if (device) device.last_seen_at = nowIso(now);
    const task = state.tasks.find(row => row.status === 'queued' && (!row.device_id || row.device_id === deviceId));
    if (!task) return null;
    task.status = 'delivered';
    task.attempts += 1;
    task.leased_at = nowIso(now);
    const intent = state.intents.find(row => row.id === task.intent_id);
    if (intent) {
      intent.status = 'dispatched';
      event(intent, 'device_task_delivered', { task_id: task.id, device_id: deviceId });
    }
    write();
    return clone(task);
  }
  function deviceResult(input = {}) {
    load();
    const task = state.tasks.find(row => row.id === String(input.task_id || ''));
    if (!task) throw new PaymentError('PAYMENT_TASK_NOT_FOUND', 404);
    if (task.device_id && task.device_id !== input.device_id) throw new PaymentError('PAYMENT_TASK_DEVICE_MISMATCH', 403);
    const status = ['opened', 'user_confirmed', 'notification_seen', 'failed'].includes(input.status) ? input.status : 'failed';
    task.status = status;
    task.completed_at = nowIso(now);
    task.message = String(input.message || '').slice(0, 2000);
    const intent = state.intents.find(row => row.id === task.intent_id);
    if (intent) {
      event(intent, 'device_task_result', { task_id: task.id, status, message: task.message });
      if (status === 'failed') intent.status = 'failed';
      else if (status === 'notification_seen') intent.status = 'waiting_settlement';
    }
    if (status === 'notification_seen' && input.settlement) {
      try { settleIntent(task.intent_id, { ...input.settlement, source: 'device_agent' }); } catch {}
    }
    write();
    return clone(task);
  }
  function tokenForSite(siteId) {
    const site = siteById(siteId);
    const config = site ? sitePayment(site) : normalizePaymentConfig(null);
    return env[config.device_token_env] || env.IH_DEVICE_AGENT_TOKEN || '';
  }
  function summary() {
    load();
    const counts = {};
    for (const intent of state.intents) counts[intent.status] = (counts[intent.status] || 0) + 1;
    return { intents: state.intents.length, tasks: state.tasks.filter(task => task.status === 'queued').length, devices: state.devices.length, counts, storage_healthy: true };
  }
  return {
    createIntent,
    listIntents,
    getIntent: id => clone(findIntent(id)),
    getTask: id => { load(); const task = state.tasks.find(row => row.id === id); return task ? clone(task) : null; },
    dispatchIntent: (id, options) => { load(); return dispatchIntent(findIntent(id), options); },
    settleIntent,
    fulfillIntent,
    cancelIntent,
    registerDevice,
    nextTask,
    deviceResult,
    tokenForSite,
    devices: () => { load(); return clone(state.devices); },
    summary,
  };
}

module.exports = { PaymentError, normalizePaymentConfig, createPaymentService };
