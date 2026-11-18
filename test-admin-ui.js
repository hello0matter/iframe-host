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
    classList: { toggle() {} },
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
    const guide = JSON.parse(evaluate(`JSON.stringify(HELP.${lang}.slice(0, 3))`));
    assert.equal(guide.length, 3);
    assert.deepEqual(guide.map(section => section.items.length), [4, 3, 4]);
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
  evaluate('loadCaptchaForm({})');
  assert.equal(evaluate('collectCaptchaForm().mode'), 'native_first');
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
  console.log('PASS: admin guide entries, bilingual errors, field validation and guide contents.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
