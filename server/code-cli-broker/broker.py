#!/usr/bin/python3
"""ST private broker core. No listener is started by importing this module."""
import hmac, json, os, re, selectors, signal, subprocess, threading, time, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LIMIT = 1_000_000
CAPS = dict(tools=False, terminal=False, files=False, mcp=False)
class Denied(Exception): pass

def validate(data, owner, models):
    allowed = {'version','requestId','ownerUserId','adapter','model','messages','maxOutputTokens','responseFormat','capabilities'}
    if not isinstance(data,dict) or set(data)-allowed: raise Denied('unknown request fields')
    if data.get('version') != 1 or not owner or data.get('ownerUserId') != owner: raise Denied('owner denied')
    try: uuid.UUID(data['requestId'])
    except (ValueError,KeyError,TypeError,AttributeError): raise Denied('invalid request id')
    adapter=data.get('adapter'); model=data.get('model')
    if adapter not in ('minimax','muse') or model not in models.get(adapter,[]): raise Denied('model denied')
    if data.get('capabilities') != CAPS: raise Denied('capabilities denied')
    cap=data.get('maxOutputTokens')
    if type(cap) is not int or not 1 <= cap <= 16000: raise Denied('token cap denied')
    msgs=data.get('messages')
    if not isinstance(msgs,list) or not 1 <= len(msgs) <= 100: raise Denied('messages denied')
    for m in msgs:
        if not isinstance(m,dict) or set(m) != {'role','content'} or m['role'] not in ('system','user','assistant') or not isinstance(m['content'],str): raise Denied('text only')
    if len(json.dumps(data).encode()) > LIMIT: raise Denied('request too large')
    return data

class Rpc:
    """Bounded newline JSON-RPC. Any tool/permission callback aborts the process tree."""
    def __init__(self, command, deadline=60):
        self.process=subprocess.Popen(command,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,start_new_session=True)
        self.selector=selectors.DefaultSelector(); self.selector.register(self.process.stdout,selectors.EVENT_READ)
        self.deadline=time.monotonic()+deadline; self.buffer=b''; self.total=0; self.seq=0; self.events=[]
    def close(self):
        try: os.killpg(self.process.pid,signal.SIGKILL)
        except ProcessLookupError: pass
        self.process.wait(timeout=5);self.selector.close()
        self.process.stdin.close();self.process.stdout.close()
    def send(self,method,params=None,notification=False):
        self.seq+=1; frame={'jsonrpc':'2.0','method':method}
        if params is not None:frame['params']=params
        if not notification:frame['id']=self.seq
        wire=json.dumps(frame).encode()+b'\n'
        if len(wire)>LIMIT:raise Denied('frame too large')
        self.process.stdin.write(wire);self.process.stdin.flush();return self.seq
    def read(self):
        while b'\n' not in self.buffer:
            left=self.deadline-time.monotonic()
            if left<=0 or not self.selector.select(left):raise Denied('adapter timeout')
            chunk=os.read(self.process.stdout.fileno(),65536)
            if not chunk:raise Denied('adapter closed')
            self.total+=len(chunk)
            if self.total>LIMIT:raise Denied('adapter output too large')
            self.buffer+=chunk
        line,self.buffer=self.buffer.split(b'\n',1)
        try:frame=json.loads(line)
        except (ValueError,TypeError):raise Denied('invalid adapter frame')
        if not isinstance(frame,dict):raise Denied('invalid adapter frame')
        method=frame.get('method','');p=frame.get('params',{})
        if method:
            # No server-originated requests are accepted, regardless of claimed role.
            if 'id' in frame:raise Denied('adapter capability request denied')
            update=p.get('update',{})
            item=p.get('item',{})
            if method.startswith(('approval/','terminal/','fs/','mcp/','userInput/')) or update.get('sessionUpdate') in ('tool_call','tool_call_update') or item.get('kind') in ('toolCall','subagent','userShell','reminderChild'):
                raise Denied('adapter tool activity denied')
            self.events.append(frame)
        return frame
    def call(self,method,params):
        ident=self.send(method,params)
        while True:
            frame=self.read()
            if frame.get('id')==ident:
                if 'error' in frame:raise Denied('adapter refused request')
                return frame.get('result',{})

class Broker:
    def __init__(self,owner,token,models,runner,replay_store=None):
        self.owner=owner;self.token=token;self.models=models;self.runner=runner
        self.lock=threading.Lock();self.seen=set();self.replay_store=replay_store
    def generate(self,auth,data):
        if not self.token or not hmac.compare_digest(auth,'Bearer '+self.token):raise Denied('unauthorized')
        data=validate(data,self.owner,self.models)
        if not self.lock.acquire(blocking=False):raise Denied('busy')
        try:
            if self.replay_store is not None:
                self.replay_store.reserve(data['requestId'])
            elif data['requestId'] in self.seen:raise Denied('replayed request')
            # Restart is a new replay horizon; callers must never retry an uncertain generation.
            if len(self.seen)>=10000:raise Denied('request ceiling reached')
            self.seen.add(data['requestId'])
            result=self.runner(data)
            if set(result) != {'version','text','finishReason'} or result['version']!=1 or not isinstance(result['text'],str) or not result['text'].strip() or result['finishReason'] not in ('stop','length') or len(result['text'].encode())>LIMIT:raise Denied('invalid result')
            return result
        finally:self.lock.release()

def serve(broker,address):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args):pass # Never log prompts, auth headers or CLI stderr.
        def do_POST(self):
            self.connection.settimeout(65)
            try:
                if self.path!='/generate' or self.headers.get('Transfer-Encoding') or self.headers.get('Content-Type')!='application/json':raise Denied('invalid request')
                count=int(self.headers.get('Content-Length','0'))
                if not 0<count<=LIMIT:raise Denied('request size denied')
                raw=self.rfile.read(count)
                if len(raw)!=count:raise Denied('truncated request')
                result=broker.generate(self.headers.get('Authorization',''),json.loads(raw))
                body=json.dumps(result).encode();self.send_response(200)
            except Exception:
                body=b'{"error":"broker request denied or failed"}';self.send_response(403)
            self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.end_headers()
            try:self.wfile.write(body)
            except (BrokenPipeError,ConnectionResetError):pass
    if address[0] not in ('127.0.0.1','::1'):raise Denied('private loopback binding required')
    if broker.replay_store is None:raise Denied('durable replay admission required for listener')
    ThreadingHTTPServer(address,Handler).serve_forever()
