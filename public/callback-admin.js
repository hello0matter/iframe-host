const callbackAdminState = { templates: [], jobs: [], id: '', draft: null, job: null };
const cbText = (en,zh) => LANG === 'zh' ? zh : en;
function cbMessage(error) {
  const messages = {
    VMQ_CHECKOUT_NOT_CONFIGURED: ['Set the VMQ checkout and callback origins on the server.','请在服务端配置 VMQ 收银台和回调的域名。'],
    VMQ_CHECKOUT_INVALID: ['Enter a unique merchant order ID, a payment method and a positive amount with at most two decimal places.','请填写唯一的业务订单号、支付方式和大于零的金额，金额最多两位小数。'],
    VMQ_CHECKOUT_CALLBACK_UNREADY: ['Enable VMQ callbacks for this site, configure its communication key and publish its template.','请开启此站的 VMQ 回调，配置通信密钥并发布模板。'],
    VMQ_CHECKOUT_REJECTED: ['VMQ rejected the order. Check its order list, communication key and payment QR configuration.','VMQ 未接受下单。请检查订单列表、通信密钥和收款码配置。'],
    VMQ_CHECKOUT_STATUS_UNKNOWN: ['Order status is unknown. Check the VMQ order list using the merchant order ID before trying again.','下单结果未确认。请先用业务订单号在 VMQ 查单，再决定是否重试。'],
    CALLBACK_VMQ_DISABLED: ['VMQ reception is disabled for this site.','本站 VMQ 接收未开启，请保存接收总开关和 VMQ 开关。'],
    CALLBACK_VMQ_KEY_MISSING: ['Configure the VMQ communication key in the server environment.','请在服务端配置 VMQ 通信密钥，必须与 VMQ 后台一致。'],
    CALLBACK_VMQ_PARAMS_INVALID: ['Unsupported VMQ notification parameters.','VMQ 参数不完整或不支持；无订单转账不能用来自动充值。'],
    CALLBACK_STORAGE_UNAVAILABLE: ['Callback storage unavailable; execution is blocked.','回调存储不可用，已停止接收和执行。'],
    CALLBACK_SIGNATURE_INVALID: ['Invalid or expired callback signature.','回调签名不正确或时间戳过期。'],
    CALLBACK_TEMPLATE_IN_USE: ['A site still references this template. Unbind it first.','站点仍绑定此模板，请先解除绑定。'],
    CALLBACK_NOT_PUBLISHED: ['Publish the template before running it.','请先发布模板；已停用的模板不能执行。'],
    CALLBACK_SIGNING_KEY_MISSING: ['Set a server-side signing secret of at least 32 bytes.','请在服务端配置至少 32 字节的签名密钥。'],
    CALLBACK_JOB_NOT_RUNNABLE: ['This task cannot run again; inspect it or send it to manual review.','此任务不能重复执行，请查看详情或转人工核对。'],
    CALLBACK_BROWSER_LEASE_INVALID: ['Browser permission expired or already used. Send the task to manual review.','浏览器执行凭证已过期或已使用，请转人工核对。'],
    CALLBACK_BUSY: ['Another task is running. Refresh later.','已有任务执行中，请稍后手动刷新。'],
    CALLBACK_EXECUTION_PAUSED: ['The site or template is disabled or no longer bound.','站点或模板已停用，或绑定发生变化，执行已暂停。'],
    CALLBACK_JOB_LIMIT: ['The 200-task safety limit has been reached. No existing receipt was discarded.','已达到 200 个任务的安全上限；不会丢弃已有回执或重复执行。'],
    CALLBACK_STEPS_INVALID: ['Use 1–12 steps, 100–3000 ms per step, and at most 8 KiB of code per step.','请配置 1–12 步，每步超时 100–3000 毫秒，代码最多 8 KiB。'],
    CALLBACK_TEMPLATE_INVALID: ['Enter a template name (up to 100 characters) and description (up to 1000).','请填写模板名称（最多 100 字）和说明（最多 1000 字）。'],
  };
  const pair = messages[error.message];
  return pair ? cbText(...pair) : error.message;
}

async function callbackTemplateOptions() {
  try {
    const data=(await api('/api/callbacks/')).data;
    $('siteCallbackTemplates').innerHTML=data.templates.filter(t=>t.published&&!t.archived).map(t=>`<option value="${esc(t.id)}">${esc(t.draft.name)} · v${t.published.version}</option>`).join('');
  } catch(e) { status('siteCallbackStatus',cbMessage(e),true); }
}
$('siteCallbackCheck').onclick=async()=>{
  try {
    if(!state.editingSiteId)throw new Error(cbText('Save the site first.','请先保存站点。'));
    const data=(await api('/api/callbacks/status/'+encodeURIComponent(state.editingSiteId))).data;
    const yes=cbText('yes','是'),no=cbText('no','否');
    status('siteCallbackStatus',cbText('Saved receiver: ','已保存接收开关：')+(data.enabled?yes:no)+cbText('; signing key configured: ','；签名密钥已配置：')+(data.key_configured?yes:no)+cbText('; VMQ enabled: ','；VMQ 接收：')+(data.vmq_enabled?yes:no)+cbText('; VMQ key configured: ','；VMQ 密钥已配置：')+(data.vmq_key_configured?yes:no)+cbText('; VMQ URL: ','；VMQ 地址：')+data.vmq_receive_path+cbText('; published version: ','；已发布版本：')+data.published_version+cbText('; storage healthy: ','；存储正常：')+(data.storage_healthy?yes:no)+cbText('. This does not save form edits or send a callback.','。此操作不会保存表单修改，也不会发起回调。'),data.enabled&&((data.vmq_enabled?!data.vmq_key_configured:!data.key_configured)||!data.published_version||!data.storage_healthy));
  }catch(e){status('siteCallbackStatus',cbMessage(e),true);}
};
function cbCollect() {
  if (!$('cbName')) return callbackAdminState.draft;
  return { name: $('cbName').value, description: $('cbDescription').value, ack_body: $('cbAck').value, steps: [...$('cbSteps').querySelectorAll('[data-cb-step]')].map(card => ({ name: card.querySelector('[data-cb-name]').value, type: card.querySelector('[data-cb-type]').value, enabled: card.querySelector('[data-cb-enabled]').value === 'true', timeout_ms: Number(card.querySelector('[data-cb-timeout]').value), code: card.querySelector('[data-cb-code]').value })) };
}
function cbNew(type = 'server_node') {
  if (type === 'page_refresh') return {name:cbText('Refresh bound user page','刷新指定用户页面'),type,enabled:false,timeout_ms:1000,code:''};
  return { name: cbText('Process parameters','处理参数'), type, enabled: type === 'server_node', timeout_ms: 1000, code: type === 'server_node' ? 'return { event_id: event.event_id, amount: Number(input.amount || 0) };' : 'return { ...input, message: "Admin calculation finished" };' };
}
function cbExecutionPlan(steps) {
  const active = steps.filter(step => step.enabled !== false);
  return {
    backend: active.filter(step => step.type === 'server_node').length,
    admin: active.filter(step => step.type === 'browser_js').length,
    page: active.filter(step => step.type === 'page_refresh').length,
    disabled: steps.length - active.length,
  };
}
function cbPlanText(steps) {
  const p = cbExecutionPlan(steps);
  const counts = cbText(`Backend ${p.backend} / admin calculation ${p.admin} / user refresh ${p.page} / disabled ${p.disabled}. `, `后端 ${p.backend} 步 / 管理员计算 ${p.admin} 步 / 用户刷新 ${p.page} 步 / 已关闭 ${p.disabled} 步。`);
  if (!p.backend && !p.admin && !p.page) return counts + cbText('No active steps: no business action will run.', '没有开启的步骤：不会执行任何业务动作。');
  return counts + (p.admin ? cbText('Manual intervention required: the task pauses at each admin calculation until an administrator runs it. ', '含人工环节：每个管理员计算步骤都会暂停，必须由管理员打开后台执行。') : p.page ? cbText('Page-dependent: refresh waits for the bound user page and blocks later steps. ', '依赖用户页面：刷新会等待绑定页面确认，并阻塞后续步骤。') : cbText('Backend-only: no browser is needed. Enable automatic backend execution in the site settings for unattended processing. ', '纯后端：不需要任何浏览器；如需无人值守，请在站点开启自动执行后端。')) + (p.admin && p.page ? cbText('User refresh also waits for its bound page. ', '用户刷新也需要等待绑定页面。') : '') + cbText('This is a workflow plan, not recharge confirmation.', '这只是流程安排，不代表充值已完成。');
}
function cbStepHint(type) {
  if (type === 'page_refresh') return cbText('Optional notification, not recharge. No JS required. Waits for the page bound by event.page_ref + event.order_ref; later steps wait too. Put business processing before this step. The application must bind orders automatically; customers need no browser settings. Missing bindings fail, never broadcast.', '可选通知，不负责充值。无需 JS；等待 event.page_ref + event.order_ref 绑定页面确认，后续步骤也会等待。业务处理应放在它前面。订单绑定需要网站代码自动接好，普通用户无需设置浏览器；缺少绑定就失败，绝不广播。');
  if (type === 'browser_js') return cbText('Advanced manual tool, not an unattended payment step. Runs only after an administrator clicks Run admin calculation. No user DOM, cookies or network. Closing the admin page does not complete this step. Its output is untrusted.', '高级人工工具，不适合无人值守支付流程。必须由管理员点击“执行管理员计算步骤”，不是服务器里的无头浏览器；不能访问用户 DOM、Cookie 或网络。关闭后台不会完成此步；输出不可信。');
  return cbText('Recommended main path: server-side synchronous data calculation, independent of browsers. No fetch, require, secrets or recharge API access yet. Returning success only finishes this code step, not an upstream recharge.', '推荐主流程：服务器同步处理数据，不依赖浏览器。目前没有 fetch、require、密钥或充值接口权限；return success 只表示代码执行结束，不表示原站已充值。');
}
function cbPublishPrompt(steps) {
  return cbText('Publish this code for future signed callbacks?\n\n', '确认发布这些代码，用于后续签名回调？\n\n') + cbPlanText(steps);
}
function cbUpdatePlan() {
  $('cbExecutionPlan').textContent = cbPlanText(cbCollect().steps);
}
function cbStart(template) {
  callbackAdminState.id = template?.id || '';
  callbackAdminState.draft = template ? JSON.parse(JSON.stringify(template.draft)) : { name: cbText('New callback template','新的回调模板'), description: '', ack_body: 'success', steps: [cbNew()] };
  cbRender();
}
async function loadCallbacks() {
  try {
    const data = await api('/api/callbacks/');
    callbackAdminState.templates = data.data.templates;
    callbackAdminState.jobs = data.data.jobs;
    if(callbackAdminState.job)callbackAdminState.job=(await api('/api/callbacks/jobs/'+callbackAdminState.job.id)).data;
    cbRenderCheckout();
    cbRender();
  } catch(e) { $('callbackRoot').textContent = cbMessage(e); }
}
function cbRenderCheckout() {
  const container = $('cbCheckout');
  const oldForm = container.querySelector('form');
  if (oldForm?.querySelector('button').disabled) return;
  const oldValues = oldForm ? new FormData(oldForm) : null;
  const output = container.querySelector('textarea')?.value || '';
  const oldLink = container.querySelector('a')?.getAttribute('href');
  const open = container.querySelector('details')?.open;
  const tr = (en,zh) => esc(cbText(en,zh));
  container.innerHTML = `<details class="card"><summary class="header">${tr('VMQ checkout','VMQ 收银台')}</summary>
    <div class="body"><form>
      <div class="row">
        <label class="field">${tr('Callback site','回调站点')}<select name="site_id" required></select></label>
        <label class="field">${tr('Merchant order ID','业务订单号')}<input name="pay_id" required maxlength="128" pattern="[A-Za-z0-9_.:\\-]+" autocomplete="off"></label>
        <label class="field">${tr('Amount (CNY)','金额（元）')}<input name="price" required type="number" min="0.01" max="999999999.99" step="0.01"></label>
        <label class="field">${tr('Payment method','支付方式')}<select name="type"><option value="2">${tr('Alipay','支付宝')}</option><option value="1">${tr('WeChat Pay','微信支付')}</option></select></label>
      </div>
      <button type="submit">${tr('Create checkout','生成收款二维码')}</button>
    </form><div class="status" id="cbCheckoutStatus" role="status"></div>
    <div class="hidden" id="cbCheckoutResult"><a target="_blank" rel="noopener noreferrer">${tr('Open VMQ checkout','打开 VMQ 收银台')}</a>
      <label class="field">${tr('Order and QR variables (JSON)','订单和二维码变量（JSON）')}<textarea readonly rows="8"></textarea></label>
    </div></div></details>`;
  const form = container.querySelector('form');
  const select = form.elements.namedItem('site_id');
  select.append(new Option(cbText('Select a site','选择站点'), ''));
  for (const site of state.sites) select.append(new Option(site.name || site.id, site.id));
  if (oldValues) for (const [key,value] of oldValues) form.elements.namedItem(key).value = value;
  container.querySelector('details').open = !!open;
  const result = $('cbCheckoutResult');
  const link = result.querySelector('a');
  const json = result.querySelector('textarea');
  if (oldLink) {
    link.href = oldLink;
    json.value = output;
    result.classList.remove('hidden');
  }
  form.onsubmit = async event => {
    event.preventDefault();
    const button = form.querySelector('button');
    button.disabled = true;
    result.classList.add('hidden');
    link.removeAttribute('href');
    json.value = '';
    status('cbCheckoutStatus',cbText('Creating order…','正在创建订单…'));
    try {
      const request = Object.fromEntries(new FormData(form));
      const {data} = await api('/api/callbacks/vmq/checkout',{method:'POST',body:JSON.stringify(request)});
      link.href = data.checkoutUrl;
      json.value = JSON.stringify(data,null,2);
      result.classList.remove('hidden');
      status('cbCheckoutStatus',cbText('Order created. Amount due: ¥','订单已创建，应付 ¥') + data.amountDue);
    } catch (error) {
      status('cbCheckoutStatus',cbMessage(error),true);
    } finally {
      button.disabled = false;
    }
  };
}
function cbStatusName(status) {
  const names = { waiting_page:['Waiting for bound user page','等待指定用户页面接收刷新'], pending: ['Pending','待执行'], running:['Running','执行中'], waiting_browser:['Waiting for admin calculation','等待管理员计算'], completed:['Workflow completed (not payment confirmation)','流程完成（非到账确认）'], failed:['Failed; no automatic retry','失败，不自动重试'], needs_review:['Interrupted; needs review','执行中断，待核对'], manual_review:['Manual review','已转人工核对'] };
  return names[status] ? cbText(...names[status]) : status;
}
function cbRender() {
  const s = callbackAdminState;
  const template = s.templates.find(t => t.id === s.id);
  const root = $('callbackRoot');
  root.innerHTML = `<div class="card"><div class="header"><div class="actions"><h1>${esc(cbText('External callback templates','外部回调模板'))}</h1><button id="cbRefresh" class="secondary">${esc(cbText('Refresh manually','手动刷新'))}</button><button id="cbAdd">${esc(cbText('New template','新建模板'))}</button></div></div><div class="body"><p class="hint">${esc(cbText('Generic signed JSON callbacks, not a universal payment gateway. Backend code runs in QuickJS/WASM hosted by Node; admin calculations run in an isolated worker; user page refresh requires a separate refresh step and session binding. No require, process, fetch, secret access or original-site DOM. Workflow completion is not payment or recharge confirmation. No background browser polling.','通用签名 JSON 回调，并非通用支付网关。后端代码由 Node 托管的 QuickJS/WASM 执行，管理员计算在后台浏览器的隔离 Worker 执行；用户页面刷新请添加独立刷新步骤并绑定会话；不开放 require、process、fetch、密钥或原站 DOM。流程完成不代表收款或充值到账。不在浏览器后台轮询。'))}</p><p class="hint">${esc(cbText('Receive URL: /__ih/callback/SITE_ID. Enable and bind the site separately. Timestamp and HMAC are required; see the user guide.','接收地址：/__ih/callback/站点ID。须单独启用站点并绑定模板，通知必须携带时间戳和 HMAC 签名；详见使用说明。'))}</p><div id="cbStatus" class="status" role="status"></div><div class="site-grid">${s.templates.map(t => `<article class="site-card"><h3>${esc(t.draft.name)}</h3><p><code>${esc(t.id)}</code></p><p>${esc(t.archived ? cbText('Archived','已归档') : t.enabled ? cbText('Enabled','已启用') : cbText('Disabled','已停用'))} · ${esc(cbText('Published version','已发布版本'))}: ${t.published?.version || '—'}</p><div class="actions"><button data-cb-edit="${esc(t.id)}">${esc(cbText('Edit','编辑'))}</button><button class="secondary" data-cb-copy="${esc(t.id)}">${esc(cbText('Copy','复制'))}</button><button class="secondary" data-cb-toggle="${esc(t.id)}">${esc(t.enabled ? cbText('Disable','停用') : cbText('Enable','启用'))}</button><button class="danger" data-cb-delete="${esc(t.id)}">${esc(cbText('Delete / archive','删除 / 归档'))}</button></div></article>`).join('') || `<p>${esc(cbText('No templates yet. Create one to begin.','暂无模板，请先新建。'))}</p>`}</div></div></div><div id="cbEditor"></div><div class="card"><div class="header"><h2>${esc(cbText('Recent tasks','最近任务'))}</h2></div><div class="body"><p class="hint">${esc(cbText('All event IDs are retained for deduplication, capped at 200 tasks. Failed or interrupted steps are not automatically replayed.','所有事件 ID 都保留用于去重，任务安全上限为 200。失败或中断步骤不会自动重放。'))}</p><div class="table-wrap"><table><thead><tr><th>${esc(cbText('Site / event','站点 / 事件'))}</th><th>${esc(cbText('Status','状态'))}</th><th>${esc(cbText('Version / step','版本 / 步骤'))}</th><th></th></tr></thead><tbody>${s.jobs.map(j => `<tr><td>${esc(j.site_id)}<br><code>${esc(j.event_id)}</code></td><td>${esc(cbStatusName(j.status))}</td><td>v${j.version} / ${j.step + 1}</td><td><button data-cb-job="${esc(j.id)}">${esc(cbText('Details','详情'))}</button></td></tr>`).join('')}</tbody></table></div><div id="cbJob"></div></div></div>`;
  $('cbRefresh').onclick = () => { if (s.draft) s.draft = cbCollect(); void loadCallbacks(); };
  $('cbAdd').onclick = () => cbStart();
  root.querySelectorAll('[data-cb-edit]').forEach(b => b.onclick = () => cbStart(s.templates.find(t => t.id === b.dataset.cbEdit)));
  root.querySelectorAll('[data-cb-copy]').forEach(b => b.onclick = () => { cbStart(s.templates.find(t => t.id === b.dataset.cbCopy)); s.id=''; s.draft.name += cbText(' (copy)','（副本）'); cbRender(); });
  root.querySelectorAll('[data-cb-toggle]').forEach(b => b.onclick = () => cbAction(async () => { const t = s.templates.find(t => t.id === b.dataset.cbToggle); await api('/api/callbacks/templates/'+t.id+'/toggle',{method:'POST',body:JSON.stringify({enabled:!t.enabled})}); }));
  root.querySelectorAll('[data-cb-delete]').forEach(b => b.onclick = () => { if (confirm(cbText('Delete this template? Templates with task history will be archived.','删除此模板？有任务历史的模板将改为归档。'))) void cbAction(async () => { await api('/api/callbacks/templates/'+b.dataset.cbDelete,{method:'DELETE'}); if(s.id===b.dataset.cbDelete){s.draft=null;s.id='';} }); });
  root.querySelectorAll('[data-cb-job]').forEach(b => b.onclick = () => cbAction(async () => { s.job=(await api('/api/callbacks/jobs/'+b.dataset.cbJob)).data; }));
  if (s.draft) cbRenderEditor(template);
  if (s.job) cbRenderJob();
}
async function cbAction(fn) {
  try { if(callbackAdminState.draft) callbackAdminState.draft=cbCollect(); await fn(); await loadCallbacks(); }
  catch(e) { status('cbStatus',cbMessage(e),true); }
}
function cbRenderEditor(template) {
  const d = callbackAdminState.draft;
  $('cbEditor').innerHTML = `<div class="card"><div class="header"><h2>${esc(cbText('Template editor','模板编辑器'))}</h2><code>${esc(callbackAdminState.id || cbText('Unsaved draft','未保存草稿'))}</code></div><div class="body"><div class="row"><label class="field">${esc(cbText('Name','名称'))}<input id="cbName" maxlength="100"></label><label class="field">${esc(cbText('Successful notification ACK body','接收成功时的回执正文'))}<input id="cbAck" maxlength="1024"></label></div><label class="field">${esc(cbText('Description','说明'))}<textarea id="cbDescription" maxlength="1000"></textarea></label><p class="hint">${esc(cbText('Return the next input. Available variables: input (previous output), event (redacted callback JSON), previous (step outputs). Backend is synchronous; browser can use promises but has no DOM or network. Sensitive JSON keys are redacted.','用 return 返回下一步输入。可用变量：input（上一步输出）、event（脱敏回调 JSON）、previous（已有步骤输出）。后端同步执行；浏览器可用 Promise，但没有 DOM 或网络。敏感 JSON 键会脱敏。'))}</p><p id="cbExecutionPlan" class="hint" role="status" aria-live="polite"></p><div id="cbSteps"></div><div class="actions"><button id="cbAddBackend" class="secondary">${esc(cbText('Add backend JS (recommended)','添加后端 JS（推荐）'))}</button></div><details id="cbOptionalSteps"><summary>${esc(cbText('Optional browser steps (not required for backend processing)','可选浏览器步骤（后端处理不需要）'))}</summary><p class="hint">${esc(cbText('New optional steps start disabled. Enable them explicitly when needed. Admin calculation requires manual operation; user refresh requires order binding in the application, not customer browser settings. Existing templates are unchanged.','新添加的可选步骤默认关闭，需要时自行开启。管理员计算需要人工操作；用户刷新需要网站代码接入订单绑定，不是让顾客设置浏览器。已有模板不变。'))}</p><div class="actions"><button id="cbAddBrowser" class="secondary">${esc(cbText('Add admin calculation (manual)','添加管理员计算（人工）'))}</button><button id="cbAddPage" class="secondary">${esc(cbText('Add user refresh (notification only)','添加用户刷新（仅通知）'))}</button></div></details><div class="actions"><button id="cbSave">${esc(cbText('Save draft','保存草稿'))}</button><button id="cbPublish">${esc(cbText('Save and publish','保存并发布'))}</button></div><p class="hint">${esc(cbText('Publishing creates an immutable version for new events; existing tasks retain their original code. Receiving is controlled separately in Edit site.','发布会为新事件建立版本快照；已有任务保留原代码。回调接收还需在编辑站点中单独开启。'))}</p><div class="row"><label class="field">${esc(cbText('Test site','模拟测试站点'))}<select id="cbTestSite">${state.sites.map(v=>`<option value="${esc(v.id)}">${esc(v.name)} (${esc(v.id)})</option>`).join('')}</select></label><label class="field">${esc(cbText('Simulated input JSON','模拟输入 JSON'))}<textarea id="cbTestInput">{"event_id":"demo","amount":100}</textarea></label></div><button id="cbTest" class="secondary">${esc(cbText('Create simulated task (no payment)','创建模拟任务（不付款）'))}</button></div></div>`;
  $('cbName').value=d.name;$('cbDescription').value=d.description;$('cbAck').value=d.ack_body;
  const guide = document.createElement('details');
  const title = document.createElement('summary'); title.textContent = cbText('How to refresh an actual user page (example)','怎样刷新真实用户页面（展开示例）');
  const text = document.createElement('p'); text.className = 'hint';
  text.textContent = cbText('1. Enable User page notifications in Edit site and reload the user page. 2. Before checkout, bind the actual order on that user page using the code below. 3. The trusted callback sender includes page_ref + order_ref in its signed JSON. 4. Add a User page refresh step and publish. For simulation, paste those two fields in the input JSON. Unbound pages make no notification requests. A missing binding fails, never broadcasts. Do not use an admin tab to bind.','① 编辑站点，开启“用户页面通知”，再刷新用户页面。② 下单前，在那个用户页面用下面代码绑定实际订单。③ 可信回调发送方将 page_ref 和 order_ref 放入签名 JSON。④ 模板添加“用户页面刷新”并发布。模拟测试时，把这两个字段填入模拟 JSON。未绑定时不请求通知接口；缺少绑定会失败，绝不广播。不要在管理后台页面执行绑定。');
  const example = document.createElement('pre'); example.style.whiteSpace = 'pre-wrap';
  example.textContent = 'const page = await window.IHCallbackPage.bind("order-123");\nconsole.log({ page_ref: page.page_ref, order_ref: page.order_ref });\n\n// Signed callback JSON / 模拟输入 JSON:\n// {"event_id":"demo-1","order_ref":"order-123","page_ref":"<page.page_ref>"}\n\n// Check / stop on the user page:\nwindow.IHCallbackPage.status();\nwindow.IHCallbackPage.stop();';
  guide.append(title,text,example); $('cbEditor').appendChild(guide);
  d.steps.forEach((step,index) => {
    const card=document.createElement('article');card.className='rule-card';card.dataset.cbStep=String(index);
    card.innerHTML=`<div class="actions"><strong>${index+1}</strong><button type="button" class="secondary" data-cb-up>${esc(cbText('Up','上移'))}</button><button type="button" class="secondary" data-cb-down>${esc(cbText('Down','下移'))}</button><button type="button" class="danger" data-cb-remove>${esc(cbText('Remove','移除'))}</button></div><div class="row"><label class="field">${esc(cbText('Step name','步骤名称'))}<input data-cb-name maxlength="100"></label><label class="field">${esc(cbText('Runtime','运行位置'))}<select data-cb-type><option value="server_node">${esc(cbText('Backend JS (restricted Node host)','后端 JS（受限 Node 宿主）'))}</option><option value="browser_js">${esc(cbText('Admin browser data calculation (Worker)','管理员浏览器计算（Worker）'))}</option><option value="page_refresh">${esc(cbText('User page: refresh bound session','用户页面：刷新绑定会话'))}</option></select></label><label class="field">${esc(cbText('Enabled','开关'))}<select data-cb-enabled><option value="true">${esc(cbText('On','开启'))}</option><option value="false">${esc(cbText('Off','关闭'))}</option></select></label><label class="field">${esc(cbText('Timeout (100–3000 ms)','超时（100–3000 毫秒）'))}<input data-cb-timeout type="number" min="100" max="3000"></label></div><textarea data-cb-code class="code-input" spellcheck="false" rows="5"></textarea>`;
    for(const [field,value] of Object.entries({name:step.name,type:step.type,enabled:String(step.enabled!==false),timeout:step.timeout_ms,code:step.code}))card.querySelector('[data-cb-'+field+']').value=value;
    const updateRuntime = () => {
      const isPage = card.querySelector('[data-cb-type]').value === 'page_refresh';
      const code = card.querySelector('[data-cb-code]');
      code.disabled = isPage; code.hidden = isPage;
      card.querySelector('[data-cb-timeout]').disabled = isPage;
      card.querySelector('[data-cb-runtime-hint]')?.remove();
      const hint = document.createElement('p'); hint.className = 'hint'; hint.dataset.cbRuntimeHint = '';
      hint.textContent = cbStepHint(card.querySelector('[data-cb-type]').value);
      card.appendChild(hint);
    };
    card.querySelector('[data-cb-type]').onchange = () => { updateRuntime(); cbUpdatePlan(); };
    card.querySelector('[data-cb-enabled]').onchange = cbUpdatePlan; updateRuntime();
    for(const [action,offset] of [['up',-1],['down',1]])card.querySelector('[data-cb-'+action+']').onclick=()=>{callbackAdminState.draft=cbCollect();const a=callbackAdminState.draft.steps;const to=index+offset;if(to>=0&&to<a.length)[a[index],a[to]]=[a[to],a[index]];cbRender();};
    card.querySelector('[data-cb-remove]').onclick=()=>{callbackAdminState.draft=cbCollect();callbackAdminState.draft.steps.splice(index,1);cbRender();};
    $('cbSteps').appendChild(card);
  });
  cbUpdatePlan();
  const add=type=>{callbackAdminState.draft=cbCollect();if(callbackAdminState.draft.steps.length>=12){status('cbStatus',cbText('At most 12 steps.','最多 12 步。'),true);return;}callbackAdminState.draft.steps.push(cbNew(type));cbRender();};
  $('cbAddBackend').onclick=()=>add('server_node');$('cbAddBrowser').onclick=()=>add('browser_js');$('cbAddPage').onclick=()=>add('page_refresh');
  const save=async()=>{const d=cbCollect();const id=callbackAdminState.id;const result=await api('/api/callbacks/templates'+(id?'/'+id:''),{method:id?'PUT':'POST',body:JSON.stringify(d)});callbackAdminState.id=result.data.id;callbackAdminState.draft=result.data.draft;};
  $('cbSave').onclick=()=>cbAction(save);
  $('cbPublish').onclick=()=>{if(confirm(cbPublishPrompt(cbCollect().steps)))void cbAction(async()=>{await save();await api('/api/callbacks/templates/'+callbackAdminState.id+'/publish',{method:'POST',body:'{}'});});};
  $('cbTest').onclick=()=>cbAction(async()=>{if(!callbackAdminState.id)throw new Error(cbText('Save and publish first.','请先保存并发布。'));const input=JSON.parse($('cbTestInput').value);callbackAdminState.job=(await api('/api/callbacks/templates/'+callbackAdminState.id+'/test',{method:'POST',body:JSON.stringify({site_id:$('cbTestSite').value,input})})).data;});
}
function cbRenderJob() {
  const j=callbackAdminState.job;
  $('cbJob').innerHTML=`<hr><h3>${esc(cbText('Task details','任务详情'))}</h3><p><code>${esc(j.id)}</code> · ${esc(cbStatusName(j.status))}</p><p>${esc(cbText('Source','来源'))}: ${esc(j.source)} · ${esc(cbText('Not a payment confirmation','不是支付到账凭证'))}</p><div class="actions"><button id="cbRun">${esc(cbText('Run / continue backend','执行 / 继续后端'))}</button><button id="cbBrowser" class="secondary">${esc(cbText('Run admin calculation','执行管理员计算步骤'))}</button><button id="cbReview" class="secondary">${esc(cbText('Send to manual review','转人工核对'))}</button></div><pre id="cbJobJson" style="white-space:pre-wrap;overflow-wrap:anywhere;max-height:420px;overflow:auto"></pre>`;
  $('cbJobJson').textContent=JSON.stringify(j,null,2);
  if (j.status === 'waiting_page') {
    const hint = document.createElement('p'); hint.className = 'hint';
    hint.textContent = cbText('Waiting for the bound user page, not this admin browser. Keep that page open; no admin execution button is needed. Click Refresh manually to check the result. Bindings expire after 30 minutes. Notification acknowledgement is not proof that refresh or payment completed.','正在等待已绑定的用户页面，不是管理后台。保持那个用户页面打开即可，无需点击“管理员计算”。稍后点顶部“手动刷新”查看结果。绑定 30 分钟过期；确认收到通知不等于刷新成功或支付到账。');
    $('cbJob').prepend(hint);
  }
  $('cbRun').disabled=j.status!=='pending';
  $('cbBrowser').disabled=j.status!=='waiting_browser';
  $('cbBrowser').hidden=j.status!=='waiting_browser';
  if (j.status === 'waiting_browser') {
    const hint = document.createElement('p'); hint.className = 'hint';
    hint.textContent = cbStepHint('browser_js');
    $('cbJob').prepend(hint);
  }
  $('cbRun').onclick=()=>cbAction(async()=>{callbackAdminState.job=(await api('/api/callbacks/jobs/'+j.id+'/run',{method:'POST',body:'{}'})).data;});
  $('cbReview').onclick=()=>cbAction(async()=>{callbackAdminState.job=(await api('/api/callbacks/jobs/'+j.id+'/review',{method:'POST',body:'{}'})).data;});
  $('cbBrowser').onclick=()=>cbAction(async()=>{if(!confirm(cbText('Run this step in an isolated browser worker?','在隔离浏览器 Worker 内执行此步骤？')))return;const lease=(await api('/api/callbacks/jobs/'+j.id+'/browser',{method:'POST',body:'{}'})).data;const result=await cbBrowserExecute(lease);callbackAdminState.job=(await api('/api/callbacks/jobs/'+j.id+'/browser-result',{method:'POST',body:JSON.stringify({...result,token:lease.token})})).data;});
}
function cbBrowserExecute(lease) {
  return new Promise(resolve=>{
    const frame=document.createElement('iframe');frame.hidden=true;frame.sandbox='allow-scripts';frame.referrerPolicy='no-referrer';frame.src='/__ih/callback/browser-frame';
    const nonce=crypto.randomUUID();let done=false;
    const finish=result=>{if(done)return;done=true;clearTimeout(timer);window.removeEventListener('message',receive);frame.remove();resolve(result);};
    const receive=e=>{if(e.source===frame.contentWindow&&e.data?.type==='callback-result'&&e.data.nonce===nonce)finish(e.data.ok===true?{ok:true,output:e.data.output}:{ok:false});};
    const timer=setTimeout(()=>finish({ok:false}),lease.timeout_ms+2500);
    window.addEventListener('message',receive);
    frame.onload=()=>frame.contentWindow.postMessage({type:'callback-run',nonce,context:lease.context,code:lease.code,timeout_ms:lease.timeout_ms},'*');
    document.body.appendChild(frame);
  });
}
function callbackApplyLanguage() {
  if(callbackAdminState.draft)callbackAdminState.draft=cbCollect();
  if(!$('callbacksView').classList.contains('hidden')){
    cbRenderCheckout();
    cbRender();
  }
}
