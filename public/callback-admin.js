const callbackAdminState = { templates: [], jobs: [], id: '', draft: null, job: null };
const cbText = (en,zh) => LANG === 'zh' ? zh : en;
function cbMessage(error) {
  const messages = {
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
    status('siteCallbackStatus',cbText('Saved receiver: ','已保存接收开关：')+(data.enabled?yes:no)+cbText('; signing key configured: ','；签名密钥已配置：')+(data.key_configured?yes:no)+cbText('; published version: ','；已发布版本：')+data.published_version+cbText('; storage healthy: ','；存储正常：')+(data.storage_healthy?yes:no)+cbText('. This does not save form edits or send a callback.','。此操作不会保存表单修改，也不会发起回调。'),data.enabled&&(!data.key_configured||!data.published_version||!data.storage_healthy));
  }catch(e){status('siteCallbackStatus',cbMessage(e),true);}
};
function cbCollect() {
  if (!$('cbName')) return callbackAdminState.draft;
  return { name: $('cbName').value, description: $('cbDescription').value, ack_body: $('cbAck').value, steps: [...$('cbSteps').querySelectorAll('[data-cb-step]')].map(card => ({ name: card.querySelector('[data-cb-name]').value, type: card.querySelector('[data-cb-type]').value, enabled: card.querySelector('[data-cb-enabled]').value === 'true', timeout_ms: Number(card.querySelector('[data-cb-timeout]').value), code: card.querySelector('[data-cb-code]').value })) };
}
function cbNew(type = 'server_node') {
  return { name: cbText('Process parameters','处理参数'), type, enabled: true, timeout_ms: 1000, code: type === 'server_node' ? 'return { event_id: event.event_id, amount: Number(input.amount || 0) };' : 'return { ...input, message: "Browser step finished" };' };
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
    cbRender();
  } catch(e) { $('callbackRoot').textContent = cbMessage(e); }
}
function cbStatusName(status) {
  const names = { pending: ['Pending','待执行'], running:['Running','执行中'], waiting_browser:['Waiting for browser','等待浏览器步骤'], completed:['Workflow completed (not payment confirmation)','流程完成（非到账确认）'], failed:['Failed; no automatic retry','失败，不自动重试'], needs_review:['Interrupted; needs review','执行中断，待核对'], manual_review:['Manual review','已转人工核对'] };
  return names[status] ? cbText(...names[status]) : status;
}
function cbRender() {
  const s = callbackAdminState;
  const template = s.templates.find(t => t.id === s.id);
  const root = $('callbackRoot');
  root.innerHTML = `<div class="card"><div class="header"><div class="actions"><h1>${esc(cbText('External callback templates','外部回调模板'))}</h1><button id="cbRefresh" class="secondary">${esc(cbText('Refresh manually','手动刷新'))}</button><button id="cbAdd">${esc(cbText('New template','新建模板'))}</button></div></div><div class="body"><p class="hint">${esc(cbText('Generic signed JSON callbacks, not a universal payment gateway. Backend code runs in QuickJS/WASM hosted by Node; browser code runs in an isolated worker. No require, process, fetch, secret access or original-site DOM. Workflow completion is not payment or recharge confirmation. No background browser polling.','通用签名 JSON 回调，并非通用支付网关。后端代码由 Node 托管的 QuickJS/WASM 执行，前端代码在隔离 Worker 执行；不开放 require、process、fetch、密钥或原站 DOM。流程完成不代表收款或充值到账。不在浏览器后台轮询。'))}</p><p class="hint">${esc(cbText('Receive URL: /__ih/callback/SITE_ID. Enable and bind the site separately. Timestamp and HMAC are required; see the user guide.','接收地址：/__ih/callback/站点ID。须单独启用站点并绑定模板，通知必须携带时间戳和 HMAC 签名；详见使用说明。'))}</p><div id="cbStatus" class="status" role="status"></div><div class="site-grid">${s.templates.map(t => `<article class="site-card"><h3>${esc(t.draft.name)}</h3><p><code>${esc(t.id)}</code></p><p>${esc(t.archived ? cbText('Archived','已归档') : t.enabled ? cbText('Enabled','已启用') : cbText('Disabled','已停用'))} · ${esc(cbText('Published version','已发布版本'))}: ${t.published?.version || '—'}</p><div class="actions"><button data-cb-edit="${esc(t.id)}">${esc(cbText('Edit','编辑'))}</button><button class="secondary" data-cb-copy="${esc(t.id)}">${esc(cbText('Copy','复制'))}</button><button class="secondary" data-cb-toggle="${esc(t.id)}">${esc(t.enabled ? cbText('Disable','停用') : cbText('Enable','启用'))}</button><button class="danger" data-cb-delete="${esc(t.id)}">${esc(cbText('Delete / archive','删除 / 归档'))}</button></div></article>`).join('') || `<p>${esc(cbText('No templates yet. Create one to begin.','暂无模板，请先新建。'))}</p>`}</div></div></div><div id="cbEditor"></div><div class="card"><div class="header"><h2>${esc(cbText('Recent tasks','最近任务'))}</h2></div><div class="body"><p class="hint">${esc(cbText('All event IDs are retained for deduplication, capped at 200 tasks. Failed or interrupted steps are not automatically replayed.','所有事件 ID 都保留用于去重，任务安全上限为 200。失败或中断步骤不会自动重放。'))}</p><div class="table-wrap"><table><thead><tr><th>${esc(cbText('Site / event','站点 / 事件'))}</th><th>${esc(cbText('Status','状态'))}</th><th>${esc(cbText('Version / step','版本 / 步骤'))}</th><th></th></tr></thead><tbody>${s.jobs.map(j => `<tr><td>${esc(j.site_id)}<br><code>${esc(j.event_id)}</code></td><td>${esc(cbStatusName(j.status))}</td><td>v${j.version} / ${j.step + 1}</td><td><button data-cb-job="${esc(j.id)}">${esc(cbText('Details','详情'))}</button></td></tr>`).join('')}</tbody></table></div><div id="cbJob"></div></div></div>`;
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
  $('cbEditor').innerHTML = `<div class="card"><div class="header"><h2>${esc(cbText('Template editor','模板编辑器'))}</h2><code>${esc(callbackAdminState.id || cbText('Unsaved draft','未保存草稿'))}</code></div><div class="body"><div class="row"><label class="field">${esc(cbText('Name','名称'))}<input id="cbName" maxlength="100"></label><label class="field">${esc(cbText('Successful notification ACK body','接收成功时的回执正文'))}<input id="cbAck" maxlength="1024"></label></div><label class="field">${esc(cbText('Description','说明'))}<textarea id="cbDescription" maxlength="1000"></textarea></label><p class="hint">${esc(cbText('Return the next input. Available variables: input (previous output), event (redacted callback JSON), previous (step outputs). Backend is synchronous; browser can use promises but has no DOM or network. Sensitive JSON keys are redacted.','用 return 返回下一步输入。可用变量：input（上一步输出）、event（脱敏回调 JSON）、previous（已有步骤输出）。后端同步执行；浏览器可用 Promise，但没有 DOM 或网络。敏感 JSON 键会脱敏。'))}</p><div id="cbSteps"></div><div class="actions"><button id="cbAddBackend" class="secondary">${esc(cbText('Add backend JS','添加后端 JS'))}</button><button id="cbAddBrowser" class="secondary">${esc(cbText('Add browser JS','添加前端 JS'))}</button><button id="cbSave">${esc(cbText('Save draft','保存草稿'))}</button><button id="cbPublish">${esc(cbText('Save and publish','保存并发布'))}</button></div><p class="hint">${esc(cbText('Publishing creates an immutable version for new events; existing tasks retain their original code. Receiving is controlled separately in Edit site.','发布会为新事件建立版本快照；已有任务保留原代码。回调接收还需在编辑站点中单独开启。'))}</p><div class="row"><label class="field">${esc(cbText('Test site','模拟测试站点'))}<select id="cbTestSite">${state.sites.map(v=>`<option value="${esc(v.id)}">${esc(v.name)} (${esc(v.id)})</option>`).join('')}</select></label><label class="field">${esc(cbText('Simulated input JSON','模拟输入 JSON'))}<textarea id="cbTestInput">{"event_id":"demo","amount":100}</textarea></label></div><button id="cbTest" class="secondary">${esc(cbText('Create simulated task (no payment)','创建模拟任务（不付款）'))}</button></div></div>`;
  $('cbName').value=d.name;$('cbDescription').value=d.description;$('cbAck').value=d.ack_body;
  d.steps.forEach((step,index) => {
    const card=document.createElement('article');card.className='rule-card';card.dataset.cbStep=String(index);
    card.innerHTML=`<div class="actions"><strong>${index+1}</strong><button type="button" class="secondary" data-cb-up>${esc(cbText('Up','上移'))}</button><button type="button" class="secondary" data-cb-down>${esc(cbText('Down','下移'))}</button><button type="button" class="danger" data-cb-remove>${esc(cbText('Remove','移除'))}</button></div><div class="row"><label class="field">${esc(cbText('Step name','步骤名称'))}<input data-cb-name maxlength="100"></label><label class="field">${esc(cbText('Runtime','运行位置'))}<select data-cb-type><option value="server_node">${esc(cbText('Backend JS (restricted Node host)','后端 JS（受限 Node 宿主）'))}</option><option value="browser_js">${esc(cbText('Browser JS (isolated worker)','前端 JS（隔离 Worker）'))}</option></select></label><label class="field">${esc(cbText('Enabled','开关'))}<select data-cb-enabled><option value="true">${esc(cbText('On','开启'))}</option><option value="false">${esc(cbText('Off','关闭'))}</option></select></label><label class="field">${esc(cbText('Timeout (100–3000 ms)','超时（100–3000 毫秒）'))}<input data-cb-timeout type="number" min="100" max="3000"></label></div><textarea data-cb-code class="code-input" spellcheck="false" rows="5"></textarea>`;
    for(const [field,value] of Object.entries({name:step.name,type:step.type,enabled:String(step.enabled!==false),timeout:step.timeout_ms,code:step.code}))card.querySelector('[data-cb-'+field+']').value=value;
    for(const [action,offset] of [['up',-1],['down',1]])card.querySelector('[data-cb-'+action+']').onclick=()=>{callbackAdminState.draft=cbCollect();const a=callbackAdminState.draft.steps;const to=index+offset;if(to>=0&&to<a.length)[a[index],a[to]]=[a[to],a[index]];cbRender();};
    card.querySelector('[data-cb-remove]').onclick=()=>{callbackAdminState.draft=cbCollect();callbackAdminState.draft.steps.splice(index,1);cbRender();};
    $('cbSteps').appendChild(card);
  });
  const add=type=>{callbackAdminState.draft=cbCollect();if(callbackAdminState.draft.steps.length>=12){status('cbStatus',cbText('At most 12 steps.','最多 12 步。'),true);return;}callbackAdminState.draft.steps.push(cbNew(type));cbRender();};
  $('cbAddBackend').onclick=()=>add('server_node');$('cbAddBrowser').onclick=()=>add('browser_js');
  const save=async()=>{const d=cbCollect();const id=callbackAdminState.id;const result=await api('/api/callbacks/templates'+(id?'/'+id:''),{method:id?'PUT':'POST',body:JSON.stringify(d)});callbackAdminState.id=result.data.id;callbackAdminState.draft=result.data.draft;};
  $('cbSave').onclick=()=>cbAction(save);
  $('cbPublish').onclick=()=>{if(confirm(cbText('Publish this code for future signed callbacks?','确认发布这些代码，用于后续签名回调？')))void cbAction(async()=>{await save();await api('/api/callbacks/templates/'+callbackAdminState.id+'/publish',{method:'POST',body:'{}'});});};
  $('cbTest').onclick=()=>cbAction(async()=>{if(!callbackAdminState.id)throw new Error(cbText('Save and publish first.','请先保存并发布。'));const input=JSON.parse($('cbTestInput').value);callbackAdminState.job=(await api('/api/callbacks/templates/'+callbackAdminState.id+'/test',{method:'POST',body:JSON.stringify({site_id:$('cbTestSite').value,input})})).data;});
}
function cbRenderJob() {
  const j=callbackAdminState.job;
  $('cbJob').innerHTML=`<hr><h3>${esc(cbText('Task details','任务详情'))}</h3><p><code>${esc(j.id)}</code> · ${esc(cbStatusName(j.status))}</p><p>${esc(cbText('Source','来源'))}: ${esc(j.source)} · ${esc(cbText('Not a payment confirmation','不是支付到账凭证'))}</p><div class="actions"><button id="cbRun">${esc(cbText('Run / continue backend','执行 / 继续后端'))}</button><button id="cbBrowser" class="secondary">${esc(cbText('Run waiting browser step','执行等待中的前端步骤'))}</button><button id="cbReview" class="secondary">${esc(cbText('Send to manual review','转人工核对'))}</button></div><pre id="cbJobJson" style="white-space:pre-wrap;overflow-wrap:anywhere;max-height:420px;overflow:auto"></pre>`;
  $('cbJobJson').textContent=JSON.stringify(j,null,2);
  $('cbRun').disabled=!['pending','waiting_browser'].includes(j.status);
  $('cbBrowser').disabled=j.status!=='waiting_browser';
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
  if(!$('callbacksView').classList.contains('hidden'))cbRender();
}
