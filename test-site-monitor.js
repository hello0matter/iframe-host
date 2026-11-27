const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeSiteMonitor, monitorFingerprint, sendPushPlus, createSiteMonitorService } = require('./site-monitor');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ih-monitor-test-'));

function site(overrides = {}) {
  return {
    id: 's1',
    name: 'Upstream',
    enabled: true,
    targetBase: 'https://upstream.example',
    targetOrigin: 'https://upstream.example',
    monitor: normalizeSiteMonitor({ enabled: true, path: '/purchase', mode: 'auto', interval_seconds: 30, notify_on_error: true, ...overrides }),
  };
}

async function main() {
  assert.equal(normalizeSiteMonitor().enabled, false);
  assert.equal(normalizeSiteMonitor().path, '/');
  assert.equal(normalizeSiteMonitor().mode, 'auto');
  assert.equal(normalizeSiteMonitor({ interval_seconds: 1 }).interval_seconds, 30);
  assert.equal(normalizeSiteMonitor({ interval_seconds: 999999 }).interval_seconds, 86400);
  assert.equal(normalizeSiteMonitor({ mode: 'bogus' }).mode, 'auto');
  assert.throws(() => normalizeSiteMonitor({ path: '//evil.example/x' }), /absolute path/);
  assert.throws(() => normalizeSiteMonitor({ path: 'https://evil.example/x' }), /absolute path/);
  assert.throws(() => normalizeSiteMonitor({ mode: 'regex', pattern: '(' }), /invalid regex/);
  assert.throws(() => normalizeSiteMonitor({ pushplus_token_env: 'bad-name' }), /invalid PushPlus/);

  const auto = normalizeSiteMonitor({ enabled: true, mode: 'auto' });
  const before = monitorFingerprint('<title>A</title><script src="/a.js"></script>', 'text/html', auto);
  const after = monitorFingerprint('<title>A</title><script src="/b.js"></script>', 'text/html', auto);
  const same = monitorFingerprint('<title>A</title><script src="/a.js"></script>', 'text/html', auto);
  assert.notEqual(before.fingerprint, after.fingerprint);
  assert.equal(before.fingerprint, same.fingerprint);
  assert.equal(before.title, 'A');
  assert.ok(before.summary.includes('/a.js'));

  const regex = normalizeSiteMonitor({ enabled: true, mode: 'regex', pattern: 'build-[a-z0-9]+' });
  const r1 = monitorFingerprint('build-aaa other', 'text/html', regex);
  const r2 = monitorFingerprint('build-bbb other', 'text/html', regex);
  assert.notEqual(r1.fingerprint, r2.fingerprint);
  assert.deepEqual(r1.summary, ['build-aaa']);

  const hash = normalizeSiteMonitor({ enabled: true, mode: 'hash' });
  assert.equal(monitorFingerprint('x', 'text/html', hash).fingerprint, monitorFingerprint('x', 'text/html', hash).fingerprint);
  assert.notEqual(monitorFingerprint('x', 'text/html', hash).fingerprint, monitorFingerprint('y', 'text/html', hash).fingerprint);

  let pushRequest = null;
  const pushResult = await sendPushPlus({
    token: 'unit-token', title: 'hello', content: 'body',
    fetchImpl: async (url, request) => {
      pushRequest = { url, request };
      return { ok: true, json: async () => ({ code: 200 }) };
    },
  });
  assert.equal(pushResult.code, 200);
  assert.equal(pushRequest.url, 'https://www.pushplus.plus/send');
  assert.deepEqual(JSON.parse(pushRequest.request.body), { token: 'unit-token', title: 'hello', content: 'body', template: 'txt' });
  await assert.rejects(() => sendPushPlus({ token: 't', title: 'x', content: 'y', fetchImpl: async () => ({ ok: true, json: async () => ({ code: 500 }) }) }), /PUSHPLUS_REJECTED_500/);

  let time = Date.UTC(2026, 0, 1, 0, 0, 0);
  let html = '<title>A</title><script src="/a.js"></script>';
  const pushes = [];
  const service = createSiteMonitorService({
    stateFile: path.join(tmp, 'state.json'),
    getSites: () => [site()],
    env: { IH_PUSHPLUS_TOKEN: 'unit-token' },
    now: () => time,
    fetchImpl: async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }),
    sendPush: async payload => { pushes.push(payload); return { code: 200 }; },
  });

  const first = await service.check('s1', { force: true });
  assert.equal(first.first, true);
  assert.equal(pushes.length, 0);
  let state = JSON.parse(fs.readFileSync(path.join(tmp, 'state.json'), 'utf8'));
  assert.equal(state.sites.s1.last.checked_at, time);

  time += 1000;
  const unchanged = await service.check('s1', { force: true });
  assert.equal(unchanged.changed, false);
  assert.equal(pushes.length, 0);
  state = JSON.parse(fs.readFileSync(path.join(tmp, 'state.json'), 'utf8'));
  assert.equal(state.sites.s1.last.checked_at, time);

  const disabledService = createSiteMonitorService({
    stateFile: path.join(tmp, 'disabled-state.json'),
    getSites: () => [site({ enabled: false })],
    env: {},
    now: () => time,
    fetchImpl: async () => new Response('<title>A</title>', { status: 200, headers: { 'content-type': 'text/html' } }),
    sendPush: async () => ({ code: 200 }),
  });
  const manualCheck = await disabledService.check('s1', { force: true });
  assert.equal(manualCheck.first, true);
  await assert.rejects(() => disabledService.check('s1'), /monitor is disabled/);

  html = '<title>A</title><script src="/b.js"></script>';
  time += 1000;
  const changed = await service.check('s1', { force: true });
  assert.equal(changed.changed, true);
  assert.equal(pushes.length, 1);
  assert.match(pushes[0].title, /Upstream/);
  assert.match(pushes[0].content, /\/b\.js/);

  time += 1000;
  await service.check('s1', { force: true });
  assert.equal(pushes.length, 1);

  const errorPushes = [];
  const broken = createSiteMonitorService({
    stateFile: path.join(tmp, 'broken.json'),
    getSites: () => [site()],
    env: { IH_PUSHPLUS_TOKEN: 'unit-token' },
    now: () => time,
    fetchImpl: async () => { throw new Error('boom'); },
    sendPush: async payload => { errorPushes.push(payload); return { code: 200 }; },
  });
  const failed = await broken.check('s1', { force: true });
  assert.equal(failed.last.ok, false);
  assert.equal(errorPushes.length, 1);
  assert.match(errorPushes[0].content, /boom/);

  const missingToken = createSiteMonitorService({
    stateFile: path.join(tmp, 'missing.json'),
    getSites: () => [site()],
    env: {},
    now: () => time,
    fetchImpl: async () => new Response('<title>A</title>', { status: 200 }),
    sendPush: async () => ({ code: 200 }),
  });
  await assert.rejects(() => missingToken.testNotify('s1'), /token_not_configured/);

  assert.equal(service.status('s1').token_configured, true);
  assert.equal(service.status('missing'), null);

  console.log('PASS: site monitor normalization, fingerprint modes, baseline write, change detection, error notification and PushPlus payload. No external request was sent.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
