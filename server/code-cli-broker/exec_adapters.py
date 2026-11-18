"""Staged native-exec adapters. Caller supplies only a fixed trusted sandbox launcher.
No auth store is read here; the CLI uses its own dedicated saved login in sandbox.
No listener, service or CLI starts on import. Launcher/cap verification remains gated.
"""
import json,os,selectors,signal,subprocess,threading,time
from broker import Denied,LIMIT

MINIMAX_MODEL='MiniMax-M3.1-Flash'
MUSE_MODEL='muse-spark-1.3-contributor'
MUSE_MODELS=frozenset({MUSE_MODEL,'muse-wonder-1.0-contributor','muse-wonder-full-1.0-contributor'})

def prompt_text(data):
    body={'messages':data['messages'],'maxOutputTokens':data['maxOutputTokens'],
        'responseFormat':data.get('responseFormat')}
    if 'reasoningEffort' in data:body['reasoningEffort']=data['reasoningEffort']
    return json.dumps(body,ensure_ascii=False)

def cli_arguments(adapter,model,reasoning_effort=None):
    # Exact catalog IDs only. No default, alias, tier substitution or request argv.
    effort=[]
    if reasoning_effort is not None:
        if not isinstance(reasoning_effort,str) or reasoning_effort not in ('minimal','low','medium','high','xhigh','max'):
            raise Denied('invalid reasoning effort')
        if model.endswith('-contributor') and reasoning_effort=='max':
            raise Denied('contributor max reasoning effort denied')
        effort=['--effort' if adapter=='minimax' else '--reasoning-effort',reasoning_effort]
    if adapter=='minimax' and model==MINIMAX_MODEL:
        return ['exec','--cwd','/work','--config','/work/runtime.yaml','--model','minimax/'+model,
            '--permission','smart','--timeout','55s','--max-steps','1','--input','-',
            '--output-format','stream-json']+effort
    if adapter=='muse' and model in MUSE_MODELS:
        return ['exec','--provider','meta','--model',model,'--preset','empty',
            '--disable-reminders','--disable-web-tools','--disable-request-user-input',
            '--no-foreign-personal-context','--no-session-log','--contributor-mode','on',
            '--max-model-steps','1',
            '-c','provider_retry.max_retries=0','--json','--prompt-file','/work/prompt.txt']+effort
    raise Denied('model denied')

class ExecState:
    def __init__(self,adapter,model):
        self.adapter=adapter;self.model=model;self.result=None;self.configured=False;self.sequence=0
        self.run=None;self.tasks=set()
    def accept(self,f):
        if not isinstance(f,dict) or self.result is not None:raise Denied('invalid exec event')
        sequence=f.get('sequence')
        if type(sequence) is not int or sequence!=self.sequence+1:raise Denied('exec sequence denied')
        self.sequence=sequence
        if self.adapter=='minimax':self._minimax(f)
        elif self.adapter=='muse':self._muse(f)
        else:raise Denied('adapter denied')
    def _minimax(self,f):
        if f.get('schemaVersion')!=1:raise Denied('exec schema denied')
        run=(f.get('runId'),f.get('sessionId'),f.get('turnId'))
        if not all(isinstance(x,str) and x for x in run):raise Denied('exec identity denied')
        if self.run is None:self.run=run
        if self.run!=run:raise Denied('exec identity changed')
        typ=f.get('type')
        if typ in ('item.started','item.updated','item.completed'):
            if f.get('item',{}).get('type') not in ('agent_message','reasoning'):raise Denied('tool activity denied')
        elif typ=='exec.completed':
            r=f.get('result',{});m=r.get('model',{})
            if r.get('status')!='succeeded' or r.get('type')!='exec.result' or r.get('schemaVersion')!=1 or m.get('providerId')!='minimax' or m.get('modelId')!=self.model:raise Denied('exec result denied')
            if (r.get('runId'),r.get('sessionId'),r.get('turnId'))!=self.run:raise Denied('exec result identity denied')
            self._finish(r.get('output'))
        elif typ not in ('exec.started','session.started','turn.started','turn.completed'):raise Denied('unexpected exec event')
    def _muse(self,f):
        if f.get('schema_version')!=1 or f.get('payload_schema_version')!=1:raise Denied('exec schema denied')
        p=f.get('payload',{});typ=f.get('payload_type');run=p.get('run_stream',{}).get('id')
        if run is not None:
            if self.run is None:self.run=run
            if self.run!=run:raise Denied('exec identity changed')
        if typ=='run.model.configured':
            if p.get('provider_id')!='meta' or p.get('model_id')!=self.model:raise Denied('exec model denied')
            self.configured=True
        elif isinstance(typ,str) and typ.startswith('task.lifecycle.'):
            e=p.get('event',{});task=e.get('task_id')
            if typ=='task.lifecycle.proposed':
                if e.get('task_kind')!='model.meta.response' or not isinstance(task,str):raise Denied('tool activity denied')
                self.tasks.add(task)
            elif task not in self.tasks:raise Denied('unknown task denied')
            if e.get('operation','model.meta.response')!='model.meta.response' or e.get('parent_task_id') is not None:raise Denied('child or tool activity denied')
            for facet in e.get('details',{}).get('facets',[]):
                if facet.get('kind')=='external_attempt' and facet.get('attempt',1)!=1:raise Denied('provider retry denied')
        elif typ=='run.terminal.completed':
            if not self.configured or p.get('terminal')!='completed':raise Denied('exec terminal denied')
            self._finish(p.get('text'))
        elif typ not in ('runtime.command.accepted','session.run.linked','run.lifecycle.started','turn.input.user','task.stream.linked','run.output.delta'):raise Denied('unexpected exec event')
    def _finish(self,text):
        if not isinstance(text,str) or not text.strip() or len(text.encode())>LIMIT:raise Denied('invalid exec text')
        self.result={'version':1,'text':text,'finishReason':'stop'}


def run_exec(data,command,cancel=None,deadline=60,*,empty_tool_inventory_verified=False):
    """command is a root-owned fixed sandbox launcher, never caller-defined CLI argv.
    It reads one request on stdin and writes JSONL CLI events only. No stderr retention.
    The sandbox launcher must kill its transient unit on parent death/disconnect.
    """
    # Trusted launcher setup only: never derive this prerequisite from request JSON.
    # Native headless permission policies cannot guarantee a pre-execution denial.
    if empty_tool_inventory_verified is not True:
        raise Denied('native exec empty-tool inventory not qualified')
    cli_arguments(data['adapter'],data['model'],data.get('reasoningEffort'))
    cancelled=cancel or threading.Event();state=ExecState(data['adapter'],data['model'])
    p=subprocess.Popen(command,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,start_new_session=True)
    sel=selectors.DefaultSelector();sel.register(p.stdout,selectors.EVENT_READ);wire=json.dumps(data).encode()+b'\n'
    if len(wire)>LIMIT:
        os.killpg(p.pid,signal.SIGKILL);p.wait();raise Denied('request size denied')
    writer_error=[]
    def write():
        try:p.stdin.write(wire);p.stdin.close()
        except (OSError,ValueError) as e:writer_error.append(type(e).__name__)
    writer=threading.Thread(target=write,daemon=True);writer.start()
    end=time.monotonic()+deadline;buf=b'';total=0
    try:
        while True:
            if cancelled.is_set():raise Denied('exec cancelled')
            if time.monotonic()>=end:raise Denied('exec timeout')
            if not sel.select(min(.1,max(0,end-time.monotonic()))):continue
            chunk=os.read(p.stdout.fileno(),65536)
            if not chunk:break
            total+=len(chunk)
            if total>LIMIT:raise Denied('exec output too large')
            buf+=chunk
            while b'\n' in buf:
                line,buf=buf.split(b'\n',1)
                try:state.accept(json.loads(line))
                except (ValueError,TypeError,KeyError,AttributeError):raise Denied('invalid exec frame')
        if buf:
            try:state.accept(json.loads(buf))
            except (ValueError,TypeError,KeyError,AttributeError):raise Denied('invalid final exec frame')
        try:
            status=p.wait(timeout=2)
        except subprocess.TimeoutExpired:
            raise Denied('exec incomplete') from None
        if writer_error or status!=0 or state.result is None:raise Denied('exec incomplete')
        return state.result
    finally:
        try:os.killpg(p.pid,signal.SIGKILL)
        except ProcessLookupError:pass
        try:p.wait(timeout=3)
        except subprocess.TimeoutExpired:pass  # never mask the original denial
        sel.close();p.stdout.close()
        writer.join(timeout=1)
        if not p.stdin.closed:p.stdin.close()
