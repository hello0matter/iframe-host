(() => {
  'use strict';
  const site = document.currentScript?.dataset.ihCallbackSite;
  if (!site || window.IHCallbackPage) return;
  const key = 'ih-callback-page:'+site;
  let binding = null;
  let controller = null;
  let generation = 0;
  let state = 'unbound';
  const store = value => { try { if (value) sessionStorage.setItem(key,JSON.stringify(value)); else sessionStorage.removeItem(key); } catch {} };
  async function request(action,body,signal) {
    const res = await fetch('/__ih/callback/page/'+encodeURIComponent(site)+'/'+action,{
      method:'POST',headers:{'Content-Type':'application/json'},credentials:'omit',cache:'no-store',body:JSON.stringify(body),signal,
    });
    if (!res.ok) { const e = new Error('PAGE_CALLBACK_'+res.status); e.status = res.status; throw e; }
    return res.json();
  }
  function stop() {
    generation++; controller?.abort(); controller = null; binding = null; state = 'unbound'; store(null);
  }
  async function listen(current,id) {
    let delay = 1000;
    while (generation === id && binding === current) {
      if (Date.now() >= current.expires_at || location.pathname !== current.path) { stop(); return; }
      controller = new AbortController();
      try {
        const {data:cmd} = await request('poll',{page_ref:current.page_ref,secret:current.secret},controller.signal);
        if (generation !== id) return;
        delay = 1000;
        if (!cmd) continue;
        if (cmd.action !== 'reload' || cmd.path !== location.pathname) { stop(); return; }
        state = 'acknowledging';
        await request('ack',{page_ref:current.page_ref,secret:current.secret,job_id:cmd.job_id,step:cmd.step},controller.signal);
        if (generation !== id) return;
        stop();
        location.reload();
        return;
      } catch(e) {
        if (generation !== id) return;
        if ([400,401,403,404,409].includes(e.status)) { stop(); state = 'expired_or_disabled'; return; }
        state = 'reconnecting';
        await new Promise(resolve => setTimeout(resolve,delay));
        delay = Math.min(delay * 2,60000);
        if (generation === id) state = 'listening';
      }
    }
  }
  function start(current) {
    binding = current; state = 'listening'; store(current);
    void listen(current,generation);
    return {page_ref:current.page_ref,order_ref:current.order_ref,expires_at:current.expires_at};
  }
  window.IHCallbackPage = Object.freeze({
    async bind(order_ref) {
      stop(); const id = generation;
      const {data} = await request('register',{order_ref,path:location.pathname});
      if (generation !== id) throw new Error('PAGE_CALLBACK_CANCELLED');
      return start({...data,order_ref,path:location.pathname});
    },
    stop,
    status:() => ({state,page_ref:binding?.page_ref || null,order_ref:binding?.order_ref || null,expires_at:binding?.expires_at || null}),
  });
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) || 'null');
    if (saved && /^[a-f0-9]{48}$/.test(saved.page_ref) && /^[a-f0-9]{64}$/.test(saved.secret) && saved.path === location.pathname && saved.expires_at > Date.now()) start(saved);
    else store(null);
  } catch { store(null); }
})();
