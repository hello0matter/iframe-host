const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, 'public/admin.html'), 'utf8');
const source = html.match(/<script>([\s\S]*?)<\/script>/)[1];
new vm.Script(source);
assert.ok(html.includes('id="helpButton"'));
assert.ok(html.includes('id="helpContents"'));
assert.ok(html.includes('data-guide="siteModal"'));
assert.ok(html.includes('data-guide="globalModal"'));
assert.ok(!html.includes('id="loginLangButton"'));
assert.ok(!html.includes('id="langButton"'));
assert.ok(html.includes('id="globalLanguage"'));

const elements = new Map();
let focused = '';
let requests = 0;
let reply = null;
function element(id = '') {
  const attributes = new Map();
  return {
    id, value: '', textContent: '', innerHTML: '',
    setAttribute: (key, value) => attributes.set(key, value),
    getAttribute: key => attributes.get(key),
    removeAttribute: key => attributes.delete(key),
    focus: () => { focused = id; },
    scrollIntoView() {},
    after: child => elements.set(child.id, child),
    remove() { elements.delete(this.id); },
    classList: { toggle() {}, add() {}, remove() {} },
  };
}
const context = vm.createContext({
  location: { pathname: '/internal-content-admin/' },
  localStorage: { getItem: () => 'zh' },
  sessionStorage: { getItem: () => '' },
  navigator: { language: 'zh-CN' },
  NodeFilter: { SHOW_TEXT: 4 },
  document: {
    body: {},
    createTreeWalker: () => ({ nextNode: () => null }),
    getElementById(id) {
      if (id.endsWith('Error')) return elements.get(id);
      if (!elements.has(id)) elements.set(id, element(id));
      return elements.get(id);
    },
    createElement: () => element(),
    querySelector: selector => { if (selector === '[') throw new Error('invalid selector'); return null; },
  },
  URL, URLSearchParams,
  fetch: async () => {
    requests++;
    if (reply) return { ok: true, json: async () => reply };
    return { ok: false, json: async () => ({ message: 'site id: 1-64 chars [A-Za-z0-9_-]' }) };
  },
});
const bootstrap = source.lastIndexOf("$('loginButton').onclick=login;");
assert.ok(bootstrap > 0);
vm.runInContext(source.slice(0, bootstrap), context);
const evaluate = code => vm.runInContext(code, context);

async function main() {
  assert.equal(evaluate("Object.keys(I18N.en).sort().join()"), evaluate("Object.keys(I18N.zh).sort().join()"));
  assert.ok(evaluate("localizeError('site id: 1-64 chars [A-Za-z0-9_-]')").includes('站点 ID'));
  assert.ok(evaluate("localizeError('invalid credentials')").includes('用户名或密码'));
  assert.ok(evaluate("localizeError('site id already exists')").includes('已存在'));
  assert.equal(evaluate("localizeError('unmapped detail')"), 'unmapped detail');

  for (const value of ['', '中文', '-bad', '_bad', 'a'.repeat(65), 'https://example.com']) {
    evaluate(`$('siteId').value=${JSON.stringify(value)}`);
    assert.throws(() => evaluate('validateSiteForm()'), /站点 ID/);
    assert.equal(focused, 'siteId');
    assert.equal(elements.get('siteId').getAttribute('aria-invalid'), 'true');
    assert.ok(elements.get('siteIdError').textContent.includes('my-site'));
  }
  assert.equal(evaluate("I18N.zh['response.direction']"), '取值方向');
  const ruleFields = {
    enabled: 'true', direction: 'request', pattern: '/api/user', mode: 'literal',
    target: 'query', key: 'lang', timeout: '1000', code: 'return "zh-CN";',
  };
  const ruleCard = { querySelector(selector) { return { value: ruleFields[selector.match(/data-response-(.+)\]/)[1]] }; } };
  const list = elements.get('responseRuleList') || element('responseRuleList');
  list.querySelectorAll = () => [ruleCard];
  elements.set('responseRuleList', list);
  assert.deepEqual(JSON.parse(evaluate('JSON.stringify(collectResponseRules())')), [{
    enabled: true, direction: 'request', url_pattern: '/api/user', match_mode: 'literal',
    target: 'query', key: 'lang', code: 'return "zh-CN";', timeout_ms: 1000,
  }]);
  ruleFields.direction = 'response';
  ruleFields.target = 'json';
  assert.equal(evaluate('collectResponseRules()[0].direction'), 'response');
  list.querySelectorAll = () => [];
  await evaluate('saveSite()');
  assert.equal(requests, 0, 'invalid ID must be rejected before an API request');
  assert.ok(elements.get('siteSaveStatus').textContent.includes('站点 ID'));

  evaluate("$('siteId').value='My-site_01';$('siteName').value='中文名称';$('siteTargetUrl').value='https://example.com';validateSiteForm()");
  assert.equal(elements.get('siteId').getAttribute('aria-invalid'), undefined);
  assert.equal(elements.has('siteIdError'), false);
  evaluate("$('siteName').value=''");
  assert.throws(() => evaluate('validateSiteForm()'), /显示名称/);
  assert.equal(focused, 'siteName');
  evaluate("$('siteName').value='test';$('siteTargetUrl').value='http://example.com'");
  assert.throws(() => evaluate('validateSiteForm()'), /HTTPS/);
  assert.equal(focused, 'siteTargetUrl');

  await assert.rejects(evaluate("api('/api/sites')"), /站点 ID/);
  evaluate('renderHelp()');
  assert.ok(elements.get('helpContents').innerHTML.includes('href="#guide-0"'));
  assert.ok(elements.get('helpContent').innerHTML.includes('全局设置与中英文切换'));
  assert.ok(elements.get('helpContent').innerHTML.includes('审计'));
  evaluate("LANG='en';renderHelp()");
  assert.ok(elements.get('helpContent').innerHTML.includes('Global settings and language'));
  assert.ok(evaluate("localizeError('site id: 1-64 chars [A-Za-z0-9_-]')").includes('Site ID'));
  assert.equal(evaluate('HELP.zh.length'), evaluate('HELP.en.length'));
  for (const lang of ['zh', 'en']) {
    const vmqGuide = evaluate(`JSON.stringify(HELP.${lang}[0])`);
    assert.ok(vmqGuide.includes('/__ih/callback/vmq/SITE_ID') || vmqGuide.includes('/__ih/callback/vmq/站点ID'));
    assert.ok(vmqGuide.includes('IH_CALLBACK_VMQ_KEY'));
    const guide = JSON.parse(evaluate(`JSON.stringify(HELP.${lang}.slice(1, 4))`));
    assert.equal(guide.length, 3);
    assert.deepEqual(guide.map(section => section.items.length), [5, 3, 4]);
    const text = guide.map(section => section.items.join(' ')).join(' ');
    for (const example of ['https://hacket.top/666/login', '#captcha-token', 'name="verification"', 'app.onVerified', '&lt;div']) {
      assert.ok(text.includes(example), `${lang} guide must explain ${example}`);
    }
    assert.ok(!/<(?:input|div)\b/i.test(text), 'example markup must be escaped');
    for (const example of ['window.app.onVerified(token)', 'window.handleCaptcha', 'pageVerified(token)', 'callback: pageVerified', 'window.receivedToken = token;']) {
      assert.ok(text.includes(example), `${lang} guide must explain callback behavior: ${example}`);
    }
    assert.ok(!text.includes('console.log'), 'examples must not encourage logging verification tokens');
  }
  evaluate('loadCallbackForm({})');
  assert.deepEqual(JSON.parse(evaluate('JSON.stringify(collectCallbackForm())')), { enabled:false, template_id:'', signing_key_env:'IH_CALLBACK_SIGNING_KEY', auto_run:false, page_enabled:false, vmq_enabled:false, vmq_key_env:'IH_CALLBACK_VMQ_KEY' });
  evaluate("$('siteCallbackVmqEnabled').value='true';$('siteCallbackVmqKeyEnv').value='IH_CALLBACK_SITE_VMQ'");
  assert.equal(evaluate('collectCallbackForm().vmq_enabled'),true);
  assert.equal(evaluate('collectCallbackForm().vmq_key_env'),'IH_CALLBACK_SITE_VMQ');
  evaluate("$('siteCallbackVmqKeyEnv').value='VMQ_SECRET'");
  assert.throws(()=>evaluate('collectCallbackForm()'), /callback|回调/);
  evaluate('loadCallbackForm({})');
  evaluate("$('siteCallbackPage').value='true'");
  assert.equal(evaluate('collectCallbackForm().page_enabled'),true);
  evaluate("$('siteCallbackEnabled').value='true'");
  assert.throws(()=>evaluate('collectCallbackForm()'), /template|模板/);
  evaluate("$('siteCallbackTemplate').value='cb-0123456789abcdef01234567';$('siteCallbackAuto').value='true'");
  assert.equal(evaluate('collectCallbackForm().auto_run'),true);
  evaluate("$('siteCallbackKeyEnv').value='PATH'");
  assert.throws(()=>evaluate('collectCallbackForm()'), /callback|回调/);
  evaluate('loadCallbackForm({})');
  assert.ok(html.includes('data-tab="callbacks"'));
  new vm.Script(fs.readFileSync(path.join(__dirname,'public/callback-admin.js'),'utf8'));
  const browserFrame = fs.readFileSync(path.join(__dirname,'public/callback-browser.html'),'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
  new vm.Script(browserFrame);
  assert.ok(html.includes('src="/__ih/callback/admin.js"'));
  evaluate('loadApiProxyForm({})');
  assert.deepEqual(JSON.parse(evaluate('JSON.stringify(collectApiProxyForm())')), { enabled: false, path_prefixes: ['/v1'], first_byte_timeout_seconds: 120, idle_timeout_seconds: 120, apply_request_rules: false, rewrite_request_headers: false });
  for (const bad of ['', 'v1', '//v1', '/v1//x', '/v1/../x', '/v1?key=1', '/v1/*']) {
    evaluate(`$('siteApiPaths').value=${JSON.stringify(bad)}`);
    assert.throws(() => evaluate('collectApiProxyForm()'), /API/);
  }
  evaluate("loadApiProxyForm({enabled:true,path_prefixes:['/v1','/api/v2'],first_byte_timeout_seconds:300,idle_timeout_seconds:60,apply_request_rules:true,rewrite_request_headers:true})");
  assert.equal(evaluate('collectApiProxyForm().enabled'), true);
  assert.equal(evaluate('collectApiProxyForm().path_prefixes.join()'), '/v1,/api/v2');
  assert.equal(evaluate('collectApiProxyForm().first_byte_timeout_seconds'), 300);
  assert.equal(evaluate('collectApiProxyForm().apply_request_rules'), true);
  for (const n of ['0', '3601', '1.5', '']) {
    evaluate(`$('siteApiIdleTimeout').value=${JSON.stringify(n)}`);
    assert.throws(() => evaluate('collectApiProxyForm()'), /API/);
  }
  evaluate('loadApiProxyForm({})');
  for (const id of ['siteApiEnabled', 'siteApiPaths', 'siteApiFirstTimeout', 'siteApiIdleTimeout', 'siteApiRules', 'siteApiRewriteHeaders']) assert.ok(html.includes('id="' + id + '"'));
  evaluate('loadCaptchaForm({})');
  assert.equal(evaluate('collectCaptchaForm().mode'), 'native_first');
  assert.equal(evaluate('collectCaptchaForm().waiting_message'), '');
  evaluate("$('siteCaptchaWaitingMessage').value=' 正在验证 ';$('siteCaptchaReadyMessage').value='验证完成 ✅'");
  assert.equal(evaluate('collectCaptchaForm().waiting_message'), '正在验证');
  assert.equal(evaluate('collectCaptchaForm().ready_message'), '验证完成 ✅');
  evaluate("$('siteCaptchaReadyMessage').value='x'.repeat(201)");
  assert.throws(() => evaluate('collectCaptchaForm()'), /200/);
  evaluate("loadCaptchaForm({waiting_message:'请稍候',ready_message:'可以登录'})");
  assert.equal(elements.get('siteCaptchaWaitingMessage').value, '请稍候');
  assert.equal(elements.get('siteCaptchaReadyMessage').value, '可以登录');
  evaluate('loadCaptchaForm({})');

  assert.equal(evaluate("$('siteCaptchaOtherMessages').open"), false);
  const extras = JSON.parse(evaluate('JSON.stringify(CAPTCHA_EXTRA_MESSAGES)'));
  for (const name of extras) {
    assert.ok(html.includes('id="siteCaptchaMessage_' + name + '"'));
    evaluate(`loadCaptchaForm(${JSON.stringify({ [name + '_message']: '提示 ' + name })})`);
    assert.equal(evaluate('collectCaptchaForm()')[name + '_message'], '提示 ' + name);
    assert.equal(evaluate("$('siteCaptchaOtherMessages').open"), true);
    evaluate(`$('siteCaptchaMessage_${name}').value='x'.repeat(201)`);
    assert.throws(() => evaluate('collectCaptchaForm()'), /200/);
  }
  evaluate('loadCaptchaForm({})');
  assert.equal(evaluate("$('siteCaptchaAdvanced').open"), false);
  assert.match(html, /<details id="siteCaptchaAdvanced"/);
  assert.match(html, /class="captcha-billing"/);
  assert.equal((html.match(/id="captchaStatusButton"/g) || []).length, 1);
  assert.equal((html.match(/id="siteCaptchaMode"/g) || []).length, 1);
  for (const config of [{ response_selector: '#token' }, { response_field_name: 'verification' }, { callback_path: 'app.onVerified' }]) {
    evaluate(`loadCaptchaForm(${JSON.stringify(config)})`);
    assert.equal(evaluate("$('siteCaptchaAdvanced').open"), true);
  }
  evaluate('loadCaptchaForm({})');
  assert.equal(evaluate("$('siteCaptchaAdvanced').open"), false);
  assert.match(html, /id="siteCaptchaLimit"[^>]*min="1"[^>]*max="100"/);
  for (const lang of ['zh', 'en']) {
    evaluate(`LANG='${lang}'`);
    for (const limit of [1, 20, 21, 100]) {
      evaluate(`$('siteCaptchaLimit').value='${limit}'`);
      assert.equal(evaluate('collectCaptchaForm().max_tasks_per_hour'), limit);
    }
    for (const limit of ['', '0', '-1', '101', '1.5', 'invalid']) {
      evaluate(`$('siteCaptchaLimit').value=${JSON.stringify(limit)}`);
      assert.throws(() => evaluate('collectCaptchaForm()'), /1[– ](?:to )?100/);
    }
    assert.equal(evaluate("localizeError('captcha: hourly limit must be 1-100')"), evaluate("t('captcha.invalidLimit')"));
  }
  evaluate("$('siteCaptchaLimit').value='100'");
  evaluate("$('siteCaptchaMode').value='provider_only';$('siteCaptchaSelector').value='#token';$('siteCaptchaCallback').value='app.onVerified';$('siteCaptchaFieldName').value='verification_token'");
  assert.equal(evaluate('collectCaptchaForm().response_selector'), '#token');
  assert.equal(evaluate('collectCaptchaForm().callback_path'), 'app.onVerified');
  evaluate("$('siteCaptchaSelector').value='['");
  assert.throws(() => evaluate('collectCaptchaForm()'), /CSS selector/);
  evaluate("$('siteCaptchaSelector').value='';$('siteCaptchaCallback').value='constructor.constructor'");
  assert.throws(() => evaluate('collectCaptchaForm()'), /global function path/);
  evaluate("state.editingSiteId='test';$('siteCaptchaEnabled').value='true';LANG='zh'");
  reply = { data: { enabled: false, mode: 'provider_only', key_configured: true, storage_healthy: true, tasks_this_hour: 0, hourly_limit: 1, active: false, recent_events: [{ at: '2026-11-18T00:00:00Z', source: 'browser', event: 'original_callback_done', page: 'abcdef123456' }] } };
  await evaluate('checkCaptchaStatus()');
  assert.ok(elements.get('captchaConfigStatus').textContent.includes('已保存服务开关：关闭'));
  assert.ok(elements.get('captchaConfigStatus').textContent.includes('请先保存'));
  assert.ok(elements.get('captchaDiagnosticEvents').textContent.includes('网页原回调已返回，未抛同步异常'));
  reply.data.recent_events = [];
  await evaluate('checkCaptchaStatus()');
  assert.ok(elements.get('captchaDiagnosticEvents').textContent.includes('暂无诊断记录'));
  reply.data.debug_enabled = false;
  await evaluate('checkCaptchaStatus()');
  assert.ok(elements.get('captchaDiagnosticEvents').textContent.includes('调试日志已关闭'));
  assert.ok(html.includes('id="siteDebugEnabled"'));
  assert.ok(html.includes('id="siteValueRulesEnabled"'));
  console.log('PASS: admin guide entries, bilingual errors, field validation, saved verification state and diagnostics.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
