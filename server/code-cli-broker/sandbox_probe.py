"""Root-only, no-auth sandbox/egress verification. Not a generation launcher."""
import asyncio,json,os,pathlib,shutil,subprocess,sys,tempfile,time,uuid
from egress import ALLOWED,public_addresses
ROOT='/opt/st-code-cli/sandbox-root'
CODE='/opt/st-code-cli/staging'
UID=995;GID=981

def properties(work,network):
    return {'User':'st-code-cli','Group':'st-code-cli','RootDirectory':ROOT,
      'MountAPIVFS':'yes','BindReadOnlyPaths':'/usr /lib /lib64 /opt/st-code-cli /etc/ssl/certs',
      'BindPaths':work+':/work','WorkingDirectory':'/work','ProtectSystem':'strict',
      'ReadWritePaths':'/work','ProtectHome':'yes','PrivateTmp':'yes','PrivateNetwork':network,
      'NoNewPrivileges':'yes','CapabilityBoundingSet':'','RestrictSUIDSGID':'yes',
      'RestrictNamespaces':'yes','NoExecPaths':'/','ExecPaths':'/usr/bin/python3 /usr/bin/python3.12 /usr/lib /lib /lib64',
      'MemoryMax':'256M','TasksMax':'16','RuntimeMaxSec':'25','TimeoutStopSec':'1',
      'KillMode':'control-group','SendSIGKILL':'yes','UMask':'0077'}

def launch(name,props,cmd):
    args=['systemd-run','--quiet','--wait','--pipe','--collect','--unit='+name]
    args += ['--property='+k+'='+v for k,v in props.items()]
    # No inherited proxy variables or HOME from root.
    args += ['--setenv=HOME=/work','--setenv=PATH=/usr/bin:/bin','--setenv=PYTHONDONTWRITEBYTECODE=1']
    return subprocess.Popen(args+cmd,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)

def cleanup(name,p):
    try:subprocess.run(['systemctl','stop',name],timeout=4,check=False,capture_output=True)
    except subprocess.TimeoutExpired:pass
    subprocess.run(['systemctl','kill','--signal=SIGKILL','--kill-whom=all',name],check=False,capture_output=True)
    try:p.wait(timeout=3)
    except subprocess.TimeoutExpired:p.kill();p.wait(timeout=2)

# Imported by the inner sandbox process; all paths and tests are fixed.
def inner():
    import socket,ssl,threading,urllib.request
    from egress import bridge
    loop=asyncio.new_event_loop()
    threading.Thread(target=lambda:loop.run_until_complete(bridge('/egress.sock')),daemon=True).start()
    for _ in range(100):
        try:s=socket.create_connection(('127.0.0.1',18080),.1);s.close();break
        except OSError:time.sleep(.02)
    try:
        s=socket.create_connection(('1.1.1.1',443),1);s.close();raise AssertionError('direct network escaped')
    except OSError:print('direct_network_denied',flush=True)
    for path in ['/app','/var/run/docker.sock','/root/.config/muse/auth.json','/var/lib/st-code-cli/.minimax/auth']:
        assert not os.path.exists(path),path
    print('host_credentials_inaccessible',flush=True)
    proxy=urllib.request.ProxyHandler({'https':'http://127.0.0.1:18080'})
    opener=urllib.request.build_opener(proxy)
    try:opener.open('https://example.com/',timeout=3);raise AssertionError('unlisted endpoint escaped')
    except OSError:print('unlisted_endpoint_denied',flush=True)
    # Read-only public endpoint, never account credentials or generation.
    try:
        with opener.open('https://account.minimax.io/',timeout=8) as response:print('provider_tls_status',response.status,flush=True)
    except urllib.error.HTTPError as exc:print('provider_tls_status',exc.code,flush=True)
    loop.call_soon_threadsafe(loop.stop)

if __name__=='__main__':
    if sys.argv[1:] == ['inner']:inner();raise SystemExit()
    if sys.argv[1:]:raise SystemExit('no arguments allowed')
    if os.getuid()!=0:raise SystemExit('root launcher required')
    adapter='minimax';resolved={}
    for host in sorted(ALLOWED[adapter]):resolved[host]=asyncio.run(public_addresses(host))
    base=tempfile.mkdtemp(prefix='egress-probe-',dir='/var/lib/st-code-cli/scratch')
    os.chown(base,UID,GID);gatewaywork=base+'/gateway';cliwork=base+'/cli'
    for d in [gatewaywork,cliwork]:os.mkdir(d,0o700);os.chown(d,UID,GID)
    suffix=uuid.uuid4().hex;units=[]
    try:
        name='st-code-cli-egress-'+suffix;props=properties(gatewaywork,'no')
        props.update(IPAddressDeny='any',IPAddressAllow=' '.join(ip for values in resolved.values() for family,ip in values))
        p=launch(name,props,['/usr/bin/python3','-I',CODE+'/egress.py','gateway',adapter,json.dumps(resolved)])
        units.append((name,p))
        for _ in range(100):
            if os.path.exists(gatewaywork+'/egress.sock'):break
            if p.poll() is not None:raise RuntimeError('gateway failed: '+p.stderr.read()[:1000])
            time.sleep(.05)
        else:raise RuntimeError('gateway readiness timeout')
        name='st-code-cli-isolation-'+suffix;props=properties(cliwork,'yes')
        props['BindReadOnlyPaths']+=' '+gatewaywork+'/egress.sock:/egress.sock'
        # -I prevents loading local modules, so fixed root-owned staging is explicitly inserted.
        code='import sys;sys.path.insert(0,"'+CODE+'");import sandbox_probe;sandbox_probe.inner()'
        p=launch(name,props,['/usr/bin/python3','-I','-c',code]);units.append((name,p))
        out,err=p.communicate(timeout=20);print(out,end='');print('sandbox_exit',p.returncode);print(err[:1000])
    finally:
        for name,p in reversed(units):cleanup(name,p)
        for name,p in units:
            state=subprocess.run(['systemctl','show',name,'-p','ActiveState','-p','ControlGroup'],capture_output=True,text=True).stdout
            print(name,state.strip().replace('\n',' '))
        shutil.rmtree(base)
