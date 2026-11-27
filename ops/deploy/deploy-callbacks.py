from __future__ import annotations
import hashlib
import json
import shlex
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'ops' / 'lib'))
from remote import connect, run

FILES = [
    'server.js', 'api-proxy.js', 'captcha-service.js', 'callback-service.js',
    'callback-routes.js', 'callback-script-worker.js', 'check-config.js',
    'package.json', 'package-lock.json', 'public/admin.html', 'public/captcha-client.js',
    'public/callback-admin.js', 'public/callback-browser.html', 'public/callback-page.js',
    'site-monitor.js', 'payment-service.js', 'payment-routes.js',
    'payment-adapters/index.js', 'payment-adapters/generic.js', 'payment-adapters/xp-pay.js', 'payment-adapters/vmq.js',
    'public/payment-capture.js', 'docs/SITE_MONITOR_AND_PAYMENTS.md',
    'docs/IFRAME_HOST_OPERATIONS.md', 'docs/EXTERNAL_CALLBACKS.md',
    'docs/PAYMENT_CALLBACK_WORKFLOW_DESIGN.md',
]
REMOTE = r"""
import hashlib,json,os,shutil,subprocess,time,urllib.request,urllib.error
from pathlib import Path
root=Path('/opt/iframe-host')
stage=Path(STAGE)
files=json.loads(MANIFEST)
config=Path('/etc/iframe-host/config.production.json')
original_config_hash=hashlib.sha256(config.read_bytes()).hexdigest()
c=json.loads(config.read_text())
base='http://127.0.0.1:3030/'+c.get('admin_path','admin').strip('/')
for f,h in files.items():
    if hashlib.sha256((stage/f).read_bytes()).hexdigest()!=h:raise RuntimeError('Staging hash mismatch: '+f)
    if f.endswith('.js'):
        with open(stage/f,'rb') as handle:subprocess.run(['node','--check'],stdin=handle,check=True,stdout=subprocess.DEVNULL)
install_env={k:v for k,v in os.environ.items() if 'proxy' not in k.lower()}
install_env.update({'npm_config_proxy':'','npm_config_https_proxy':''})
installed=subprocess.run(['npm','ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],cwd=stage,env=install_env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=180)
if installed.returncode:raise RuntimeError('Staged npm ci failed; running service was not changed')
smoke="require('./callback-service').runBackend({code:'return input.value+1;',timeout_ms:5000},{input:{value:1},event:{},previous:[]}).then(v=>{if(v!==2)process.exit(1)}).catch(()=>process.exit(1))"
for attempt in range(3):
    smoke_run=subprocess.run(['node','-e',smoke],cwd=stage,env=install_env,timeout=30,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    if smoke_run.returncode==0:break
    time.sleep(1)
if smoke_run.returncode:raise RuntimeError('Staged JS smoke test failed: '+(smoke_run.stderr or b'').decode('utf-8','replace')[-800:])
print('Staged dependencies installed directly; isolated JS smoke test passed.',flush=True)
def call(url,data=None,token=None):
    headers={'Content-Type':'application/json'}
    if token:headers['Authorization']='Bearer '+token
    req=urllib.request.Request(url,data=json.dumps(data).encode() if data is not None else None,headers=headers)
    with urllib.request.urlopen(req,timeout=15) as r:return json.load(r)
def login():return call(base+'/api/login',{'username':c.get('admin_username','admin'),'password':c['admin_password']})['token']
token=login()
sites=c.get('sites',[])
if isinstance(sites,dict):sites=[dict(v,id=k) for k,v in sites.items()]
def idle():
    for s in sites:
        if s.get('enabled',True) and s.get('captcha',{}).get('enabled',False):
            if call(base+'/api/sites/'+s['id']+'/captcha-status',token=token)['data']['active']:return False
    try:
        activity=call(base+'/api/callbacks/',token=token)['data']
        if activity.get('running') or activity.get('active_browser_count',0) or activity.get('active_page_count',0):return False
    except urllib.error.HTTPError as e:
        if e.code!=404:raise
    state=config.parent/'callback-state.json'
    if state.exists():
        data=json.loads(state.read_text())
        if any(j.get('status')=='running' or j.get('lease') for j in data.get('jobs',[])):return False
    return True
end=time.monotonic()+180
while not idle():
    if time.monotonic()>end:raise RuntimeError('Active task remains; deployment deferred')
    time.sleep(5)
if hashlib.sha256(config.read_bytes()).hexdigest()!=original_config_hash:raise RuntimeError('Configuration changed during staging; retry deployment')
backup=Path('/root/iframe-host-backups')/stage.name
backup.mkdir(parents=True,mode=0o700)
old=[]
for f in files:
    source=root/f
    if source.exists():
        dest=backup/f;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(source,dest);old.append(f)
shutil.copy2(config,backup/'config.production.json')
if (config.parent/'callback-state.json').exists():shutil.copy2(config.parent/'callback-state.json',backup/'callback-state.json')
owner=(root/'server.js').stat()
for f in files:
    os.chown(stage/f,owner.st_uid,owner.st_gid);os.chmod(stage/f,0o644)
subprocess.run(['chown','-R',str(owner.st_uid)+':'+str(owner.st_gid),str(stage/'node_modules')],check=True)
subprocess.run(['systemctl','stop','iframe-host.service'],check=True)
modules_moved=False
try:
    if (root/'node_modules').exists():os.replace(root/'node_modules',backup/'node_modules');modules_moved=True
    os.replace(stage/'node_modules',root/'node_modules')
    for f in files:
        (root/f).parent.mkdir(parents=True,exist_ok=True)
        os.replace(stage/f,root/f)
    subprocess.run(['systemctl','start','iframe-host.service'],check=True)
    def fetch(url,expected=None):
        error=None
        for _ in range(60):
            try:
                with urllib.request.urlopen(urllib.request.Request(url,headers={'Cache-Control':'no-cache'}),timeout=15) as response:body=response.read()
                if expected and hashlib.sha256(body).hexdigest()!=expected:raise RuntimeError('Public hash mismatch')
                return body
            except Exception as e:error=e;time.sleep(1)
        raise error
    fetch(base+'/')
    public='https://hacket.top'
    fetch(public+'/'+c.get('admin_path','admin').strip('/')+'/?deploy='+stage.name,files['public/admin.html'])
    fetch(public+'/__ih/callback/admin.js?deploy='+stage.name,files['public/callback-admin.js'])
    fetch(public+'/__ih/callback/browser-frame?deploy='+stage.name,files['public/callback-browser.html'])
    fetch(public+'/__ih/callback/page-client.js?deploy='+stage.name,files['public/callback-page.js'])
    fetch(public+'/__ih/payment/capture.js?deploy='+stage.name,files['public/payment-capture.js'])
    token=login()
    data=call(base+'/api/callbacks/',token=token)['data']
    if not data['storage_healthy']:raise RuntimeError('Callback storage is unhealthy')
    for f,h in files.items():
        if hashlib.sha256((root/f).read_bytes()).hexdigest()!=h:raise RuntimeError('Deployed hash mismatch')
    if hashlib.sha256(config.read_bytes()).hexdigest()!=original_config_hash:raise RuntimeError('Configuration changed unexpectedly')
    subprocess.run(['systemctl','is-active','--quiet','iframe-host.service'],check=True)
except Exception:
    subprocess.run(['systemctl','stop','iframe-host.service'])
    for f in files:
        if f in old:shutil.copy2(backup/f,root/f)
        elif (root/f).exists():(root/f).unlink()
    if modules_moved:
        if (root/'node_modules').exists():os.replace(root/'node_modules',stage/'failed-node_modules')
        os.replace(backup/'node_modules',root/'node_modules')
    subprocess.run(['systemctl','start','iframe-host.service'])
    raise
print('Service healthy; callback admin API, public UI assets and deployment hashes verified.')
print('Production configuration unchanged. No callback, payment or paid captcha task was created.')
print('Backup: '+str(backup))
"""

def main() -> int:
    manifest={f:hashlib.sha256((ROOT/f).read_bytes()).hexdigest() for f in FILES}
    stage='/opt/iframe-host/.callback-deploy-'+datetime.now().strftime('%Y%m%d-%H%M%S')
    client=connect()
    try:
        code,_,_=run(client,'mkdir -p '+shlex.quote(stage+'/public')+' '+shlex.quote(stage+'/docs')+' '+shlex.quote(stage+'/payment-adapters'))
        if code:raise RuntimeError('Cannot create deployment staging directory')
        sftp=client.open_sftp()
        try:
            for f in FILES:sftp.put(str(ROOT/f),stage+'/'+f)
        finally:sftp.close()
        script=REMOTE.replace('STAGE',repr(stage)).replace('MANIFEST',repr(json.dumps(manifest)))
        code,output,errors=run(client,'python3 -c '+shlex.quote(script),timeout=420)
        print(output,end='')
        if code:
            print(errors[-1800:],file=sys.stderr)
            return code
        return 0
    finally:client.close()

if __name__ == '__main__':raise SystemExit(main())
