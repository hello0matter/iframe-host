const assert = require('node:assert/strict');
const { normalizeApiProxy, matchesApiProxy } = require('./api-proxy');
const defaults = normalizeApiProxy();
assert.equal(defaults.enabled, false);
assert.equal(defaults.first_byte_timeout_seconds, 120);
assert.equal(defaults.idle_timeout_seconds, 120);
assert.equal(defaults.apply_request_rules, false);
assert.equal(defaults.rewrite_request_headers, false);
assert.equal(matchesApiProxy(defaults, '/v1/models'), false);
const active = normalizeApiProxy({ enabled: true, path_prefixes: ['/v1/', '/api/v2', '/v1'] });
assert.deepEqual(active.path_prefixes, ['/v1', '/api/v2']);
for (const p of ['/v1', '/v1/', '/v1/chat/completions', '/api/v2/models']) assert.equal(matchesApiProxy(active, p), true);
for (const p of ['/v10', '/v1x', '/api/v20', '/login']) assert.equal(matchesApiProxy(active, p), false);
assert.equal(matchesApiProxy(normalizeApiProxy({ enabled: true, path_prefixes: ['/'] }), '/login'), true);
for (const raw of [null, [], 'yes', { enabled: 'true' }, { apply_request_rules: 1 }, { rewrite_request_headers: 'false' }, { path_prefixes: [] }, { path_prefixes: '/v1' }, ...['v1', '//v1', '/v1//x', '/v1/../x', '/v1/./x', '/v1?key=1', '/v1#x', '/v1/*', '/v1/%2e', '/v1/\\x', '/' + 'x'.repeat(256)].map(p => ({ path_prefixes: [p] })), { path_prefixes: Array(33).fill('/v1') }]) assert.throws(() => normalizeApiProxy(raw));
for (const key of ['first_byte_timeout_seconds', 'idle_timeout_seconds']) {
  for (const n of [0, -1, 3601, 1.5, '120', null, NaN]) assert.throws(() => normalizeApiProxy({ [key]: n }));
  for (const n of [1, 120, 3600]) assert.equal(normalizeApiProxy({ [key]: n })[key], n);
}
assert.deepEqual(normalizeApiProxy(JSON.parse(JSON.stringify(active))), active);
console.log('PASS: API passthrough defaults, path boundaries, strict limits and configuration round-trip.');
