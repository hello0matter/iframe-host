const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { normalizePaymentConfig, createPaymentService, PaymentError } = require('./payment-service');
const { normalizePaymentIntent } = require('./payment-adapters');
const { mountPaymentRoutes, captureMatches, injectPaymentCapture } = require('./payment-routes');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ih-payment-test-'));

function site(overrides = {}) {
  return {
    id: 's1',
    name: '8888ok',
    enabled: true,
    targetBase: 'https://8888ok.cc',
    targetOrigin: 'https://8888ok.cc',
    proxyPrefix: '/666',
    payment: normalizePaymentConfig({ enabled: true, adapter: 'xp_pay', capture_enabled: true, require_user_approval: true, ...overrides }),
  };
}

function rejects(fn, code) {
  assert.throws(fn, error => error instanceof PaymentError && error.code === code);
}

async function main() {
  assert.equal(normalizePaymentConfig().adapter, 'generic');
  assert.equal(normalizePaymentConfig().capture_match_mode, 'regex');
  assert.equal(normalizePaymentConfig({ adapter: 'xp_pay' }).field_map.order_ref, 'out_trade_no');
  assert.equal(normalizePaymentConfig({ adapter: 'vmq' }).field_map.amount, 'reallyPrice');
  assert.equal(normalizePaymentConfig({ capture_match_mode: 'weird' }).capture_match_mode, 'regex');
  assert.throws(() => normalizePaymentConfig({ capture_url_pattern: '(' }), /invalid capture regex/);
  assert.throws(() => normalizePaymentConfig({ device_token_env: 'bad-name' }), /invalid device token/);
  assert.throws(() => normalizePaymentConfig({ device_id: 'bad id' }), /invalid device id/);

  const configured = site();
  const xp = normalizePaymentIntent({
    adapter: 'xp_pay',
    data: {
      order_id: 14409, amount: 10, pay_amount: 10.1, status: 'PENDING', payment_type: 'alipay',
      out_trade_no: 'sub2_20261127DMeT2qLp', pay_url: 'https://api.zxspro.cn/xpay/epay/submit.php?x=1',
      currency: 'CNY', expires_at: '2026-11-27T18:01:39.418951+08:00', payment_mode: 'popup',
    },
  }, configured);
  assert.equal(xp.order_ref, 'sub2_20261127DMeT2qLp');
  assert.equal(xp.amount, '10.10');
  assert.equal(xp.kind, 'qr');
  assert.equal(xp.qr_content, 'https://api.zxspro.cn/xpay/epay/submit.php?x=1');
  assert.equal(xp.provider, 'xp_pay');
  assert.equal(xp.metadata.payment_mode, 'popup');

  const mapped = normalizePaymentIntent({ adapter: 'xp_pay', order_ref: 'sub2_X', amount: '10.10', qr_content: 'https://pay.example/x', channel: 'alipay', currency: 'CNY' }, configured);
  assert.equal(mapped.order_ref, 'sub2_X');
  assert.equal(mapped.amount, '10.10');
  assert.equal(mapped.qr_content, 'https://pay.example/x');
  const mappedVmq = normalizePaymentIntent({ adapter: 'vmq', order_ref: 'V-1', amount: '1.01', qr_content: 'https://vmq.example/qr' }, configured);
  assert.equal(mappedVmq.order_ref, 'V-1');
  assert.equal(mappedVmq.amount, '1.01');

  assert.throws(() => normalizePaymentIntent({ adapter: 'generic', amount: 1, qr_content: 'x' }, configured), /order reference/);
  assert.throws(() => normalizePaymentIntent({ adapter: 'generic', order_ref: 'O', amount: 0, qr_content: 'x' }, configured), /invalid amount/);

  assert.equal(captureMatches(configured, 'POST', 'https://8888ok.cc/api/v1/payment/orders'), true);
  assert.equal(captureMatches(configured, 'POST', 'https://8888ok.cc/666/api/v1/payment/orders'), true);
  assert.equal(captureMatches(configured, 'POST', 'https://8888ok.cc/api/v1/payment/order'), false);
  assert.equal(captureMatches(configured, 'GET', 'https://8888ok.cc/api/v1/payment/orders'), false);
  const injected = injectPaymentCapture('<html><body>x</body></html>', configured);
  assert.match(injected, /payment\/capture\.js/);
  assert.match(injected, /data-ih-payment-site="s1"/);
  assert.equal(injectPaymentCapture('<body>x</body>', { ...configured, payment: normalizePaymentConfig({ enabled: false }) }), '<body>x</body>');

  let time = Date.UTC(2026, 0, 1, 0, 0, 0);
  const service = createPaymentService({
    stateFile: path.join(tmp, 'payment-state.json'),
    getSites: () => [configured],
    env: { IH_DEVICE_AGENT_TOKEN: 'devtoken' },
    now: () => time,
  });
  assert.equal(service.tokenForSite('s1'), 'devtoken');

  const created = service.createIntent('s1', { adapter: 'xp_pay', order_ref: 'O-1', amount: '10.10', qr_content: 'https://pay.example/1', expires_at: '2026-12-01T00:00:00Z' }, { source: 'browser_capture' });
  assert.equal(created.duplicate, false);
  assert.equal(created.intent.status, 'awaiting_user_approval');
  assert.equal(created.intent.amount, '10.10');
  assert.equal(created.intent.qr_content, 'https://pay.example/1');

  const duplicate = service.createIntent('s1', { adapter: 'xp_pay', order_ref: 'O-1', amount: '10.10', qr_content: 'https://pay.example/1' });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.intent.id, created.intent.id);

  rejects(() => service.settleIntent(created.intent.id, { order_ref: 'O-1', amount: 9.99 }), 'PAYMENT_SETTLEMENT_MISMATCH');
  assert.equal(service.getIntent(created.intent.id).status, 'needs_review');
  rejects(() => service.settleIntent(created.intent.id, { order_ref: 'OTHER', amount: 10.10 }), 'PAYMENT_SETTLEMENT_ORDER_MISMATCH');

  const dispatched = service.dispatchIntent(created.intent.id, { execution: 'qr_open_device', device_id: 'phone-1' });
  assert.equal(dispatched.status, 'dispatched');
  assert.equal(dispatched.task_id.length > 0, true);
  const task = service.nextTask('phone-1');
  assert.ok(task);
  assert.equal(task.status, 'delivered');
  assert.equal(task.payload.order_ref, 'O-1');
  assert.equal(task.payload.amount, '10.10');
  assert.equal(service.nextTask('phone-1'), null);

  rejects(() => service.deviceResult({ task_id: task.id, device_id: 'phone-2', status: 'opened' }), 'PAYMENT_TASK_DEVICE_MISMATCH');
  const reported = service.deviceResult({ task_id: task.id, device_id: 'phone-1', status: 'notification_seen', settlement: { order_ref: 'O-1', amount: '10.10' } });
  assert.equal(reported.status, 'notification_seen');
  assert.equal(service.getIntent(created.intent.id).status, 'settled');
  const fulfilled = service.fulfillIntent(created.intent.id, { result: 'recharged', reference: '8888-1' });
  assert.equal(fulfilled.status, 'fulfilled');

  const cancelMe = service.createIntent('s1', { adapter: 'xp_pay', order_ref: 'O-2', amount: '2.00', qr_content: 'https://pay.example/2' });
  assert.equal(service.cancelIntent(cancelMe.intent.id).status, 'cancelled');
  const recreated = service.createIntent('s1', { adapter: 'xp_pay', order_ref: 'O-2', amount: '2.00', qr_content: 'https://pay.example/2' });
  assert.equal(recreated.duplicate, false);

  const autoSite = site({ require_user_approval: false, auto_dispatch: true, default_execution: 'qr_display' });
  const autoService = createPaymentService({ stateFile: path.join(tmp, 'auto.json'), getSites: () => [autoSite], now: () => time });
  const auto = autoService.createIntent('s1', { adapter: 'xp_pay', order_ref: 'A-1', amount: '3.00', qr_content: 'https://pay.example/3' });
  assert.equal(auto.intent.status, 'waiting_settlement');

  assert.equal(service.registerDevice({ device_id: 'phone-1', name: 'Phone' }).id, 'phone-1');
  rejects(() => service.registerDevice({ device_id: 'bad id' }), 'PAYMENT_DEVICE_INVALID');
  assert.equal(service.summary().intents >= 2, true);

  const app = express();
  mountPaymentRoutes(app, { service, adminBase: '/admin', ensureAuth: (req, res, next) => next(), getSites: () => [configured] });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const unauthorized = await fetch(base + '/__ih/payment/device/next?site_id=s1&device_id=phone-none', { headers: { 'x-ih-device-token': 'wrong' } });
    assert.equal(unauthorized.status, 401);
    const authorized = await fetch(base + '/__ih/payment/device/next?site_id=s1&device_id=phone-none', { headers: { 'x-ih-device-token': 'devtoken' } });
    assert.equal(authorized.status, 204);
    const badOrigin = await fetch(base + '/__ih/payment/capture/s1', {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ method: 'POST', url: 'https://8888ok.cc/api/v1/payment/orders', response: {} }),
    });
    assert.equal(badOrigin.status, 403);
    const captured = await fetch(base + '/__ih/payment/capture/s1', {
      method: 'POST', headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({
        method: 'POST', url: 'https://8888ok.cc/api/v1/payment/orders',
        response: { code: 0, data: { out_trade_no: 'HTTP-1', pay_amount: 5.5, pay_url: 'https://pay.example/5', payment_type: 'alipay', currency: 'CNY' } },
      }),
    });
    assert.equal(captured.status, 201);
    const capturedBody = await captured.json();
    assert.equal(capturedBody.data.status, 'awaiting_user_approval');
    const capturedIntent = service.getIntent(capturedBody.data.intent_id);
    assert.equal(capturedIntent.order_ref, 'HTTP-1');
    assert.equal(capturedIntent.amount, '5.50');
    const listed = await fetch(base + '/admin/api/payments?site_id=s1&limit=5');
    assert.equal(listed.status, 200);
    assert.ok((await listed.json()).intents.some(intent => intent.order_ref === 'HTTP-1'));
  } finally {
    server.close();
  }

  console.log('PASS: payment config, XPAY normalization, mapped capture fields, deduplication, settlement mismatch, device tasks, fulfillment and device token auth.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
