"""Fixed no-auth, no-network, no-generation MSP session probe."""
import json,os,pathlib,selectors,signal,shutil,subprocess,tempfile,time,uuid
from sandbox_probe import properties,launch,cleanup,CODE,UID,GID
MUSE='/opt/st-code-cli/muse/muse-1.4.9-R6297.1'
def uuid7():
    return str(uuid.UUID(int=(int(time.time()*1000)<<80)|(7<<76)|((uuid.uuid4().int>>64&0xfff)<<64)|(2<<62)|(uuid.uuid4().int&((1<<62)-1))))
def inner():
    env={'HOME':'/work','PATH':'/usr/bin:/bin','XDG_CONFIG_HOME':'/work/.config','XDG_DATA_HOME':'/work/.local/share','XDG_STATE_HOME':'/work/.local/state','XDG_CACHE_HOME':'/work/.cache'}
    p=subprocess.Popen([MUSE,'serve','--provider','echo','--no-session-log','--disable-write','--disable-shell','--disable-request-user-input'],env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
    sel=selectors.DefaultSelector();sel.register(p.stdout,selectors.EVENT_READ);buf=b''
    def call(i,m,params,notification=False):
        nonlocal buf
        frame=dict(jsonrpc='2.0',method=m,params=params)
        if not notification:frame['id']=i
        p.stdin.write(json.dumps(frame).encode()+b'\n');p.stdin.flush()
        if notification:return
        deadline=time.monotonic()+10
        while time.monotonic()<deadline:
            while b'\n' in buf:
                line,buf=buf.split(b'\n',1);f=json.loads(line)
                if f.get('id')==i:return f
                if 'method' in f and 'id' in f:raise RuntimeError('callback denied')
            if not sel.select(.2):continue
            chunk=os.read(p.stdout.fileno(),65536)
            if not chunk:raise RuntimeError('closed')
            buf+=chunk
            if len(buf)>1000000:raise RuntimeError('output cap')
        raise TimeoutError(m)
    try:
        print('initialize',json.dumps(call(1,'initialize',dict(clientInfo=dict(name='st_code_cli_probe',version='1'),capabilities=dict(requestedCapabilities=[],userInputDialogs=False)))),flush=True)
        call(2,'initialized',{},True)
        print('session',json.dumps(call(3,'session/start',dict(commandId=uuid7(),workspaceRoot='/work',providerId='echo',approvalMode='denyUnmatched',config=dict(mcpServers={})))),flush=True)
    except Exception as e:print(type(e).__name__,str(e),flush=True)
    finally:
        os.killpg(p.pid,signal.SIGKILL);p.wait(timeout=2);sel.close();print('stderr',p.stderr.read()[:3000].decode(errors='replace'),flush=True)
if __name__=='__main__':
    if os.getuid()!=0:raise SystemExit('root only')
    work=tempfile.mkdtemp(prefix='muse-noauth-',dir='/var/lib/st-code-cli/scratch');os.chown(work,UID,GID)
    for d in ['.config','.local','.local/share','.local/state','.cache']:
        os.mkdir(work+'/'+d,0o700);os.chown(work+'/'+d,UID,GID)
    unit='st-code-cli-muse-'+uuid.uuid4().hex;props=properties(work,'yes');props['ExecPaths']+=' '+MUSE;props['MemoryMax']='1G';props['TasksMax']='64'
    code='import sys;sys.path.insert(0,"'+CODE+'");import muse_session_probe;muse_session_probe.inner()'
    p=launch(unit,props,['/usr/bin/python3','-I','-c',code])
    try:
        out,err=p.communicate(timeout=24);print(out,end='');print('exit',p.returncode,err[:600])
    finally:cleanup(unit,p);print(subprocess.run(['systemctl','show',unit,'-p','ActiveState','-p','ControlGroup'],capture_output=True,text=True).stdout);shutil.rmtree(work)
