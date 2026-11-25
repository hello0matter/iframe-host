const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const elements = new Map();
const source = fs.readFileSync('public/callback-admin.js', 'utf8');
const context = vm.createContext({
  LANG: 'zh',
  $: id => {
    if (!elements.has(id)) elements.set(id, {});
    return elements.get(id);
  },
});
vm.runInContext(source, context);
const evaluate = code => vm.runInContext(code, context);
const steps = [
  { type: 'server_node', enabled: true },
  { type: 'browser_js', enabled: false },
  { type: 'page_refresh', enabled: false },
];
context.steps = steps;
assert.equal(evaluate('cbNew().type'), 'server_node');
assert.equal(evaluate('cbNew().enabled'), true);
assert.equal(evaluate('cbNew("browser_js").enabled'), false);
assert.equal(evaluate('cbNew("page_refresh").enabled'), false);
assert.deepEqual(JSON.parse(evaluate('JSON.stringify(cbExecutionPlan(steps))')), { backend: 1, admin: 0, page: 0, disabled: 2 });
assert.match(evaluate('cbPlanText(steps)'), /纯后端/);
assert.match(evaluate('cbPlanText(steps)'), /自动执行后端/);
steps[1].enabled = true;
assert.match(evaluate('cbPublishPrompt(steps)'), /必须由管理员/);
steps[2].enabled = true;
assert.match(evaluate('cbPlanText(steps)'), /用户刷新也需要等待/);
steps[1].enabled = false;
assert.match(evaluate('cbPlanText(steps)'), /阻塞后续步骤/);
steps.forEach(step => { step.enabled = false; });
assert.match(evaluate('cbPlanText(steps)'), /没有开启的步骤/);
assert.match(evaluate('cbPlanText([])'), /不会执行任何业务动作/);
assert.match(evaluate('cbStepHint("server_node")'), /没有 fetch/);
assert.match(evaluate('cbStepHint("browser_js")'), /不是服务器里的无头浏览器/);
assert.match(evaluate('cbStepHint("page_refresh")'), /普通用户无需设置浏览器/);
assert.match(evaluate('cbStepHint("page_refresh")'), /业务处理应放在它前面/);
evaluate('LANG = "en"');
assert.match(evaluate('cbPublishPrompt([{type:"browser_js"}])'), /Manual intervention required/);
assert.match(evaluate('cbPlanText([{type:"server_node"}])'), /Backend-only/);
assert.match(evaluate('cbStepHint("page_refresh")'), /customers need no browser settings/);
assert.ok(source.includes('id="cbOptionalSteps"'));
assert.ok(source.includes('aria-live="polite"'));
assert.ok(source.includes("cbPublishPrompt(cbCollect().steps)"));
assert.ok(source.includes("[data-cb-enabled]').onchange = cbUpdatePlan"));
assert.ok(source.includes("$('cbBrowser').hidden=j.status!=='waiting_browser'"));
console.log('PASS: backend-first defaults, disabled optional browser steps, bilingual execution plans and publish warnings.');
