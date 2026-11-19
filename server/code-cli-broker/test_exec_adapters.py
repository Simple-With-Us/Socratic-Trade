import copy,json,pathlib,sys,threading,unittest
from exec_adapters import ExecState,cli_arguments,run_exec,MINIMAX_MODEL,MUSE_MODEL
from broker import Denied
from unittest.mock import patch

def fixture_exec(*args, **kwargs):
 kwargs['empty_tool_inventory_verified']=True
 return run_exec(*args, **kwargs)
ROOT=pathlib.Path(__file__).parent

def frames(adapter):return [json.loads(l) for l in (ROOT/'fixtures'/(adapter+'-success.jsonl')).read_text().splitlines()]
def request():return dict(adapter='minimax',model=MINIMAX_MODEL,messages=[dict(role='user',content='offline')],maxOutputTokens=20)
class Tests(unittest.TestCase):
 def parse(self,a,fs):
  state=ExecState(a,MINIMAX_MODEL if a=='minimax' else MUSE_MODEL)
  for f in fs:state.accept(f)
  return state.result
 def test_minimax(self):self.assertEqual(self.parse('minimax',frames('minimax'))['text'],'offline probe')
 def test_muse(self):self.assertEqual(self.parse('muse',frames('muse'))['text'],'offline probe')
 def test_commands_no_api_credentials(self):
  for a,m in [('minimax',MINIMAX_MODEL),('muse',MUSE_MODEL)]:
   args=cli_arguments(a,m)
   for arg in ['--api-key-stdin','--base-url','--yolo','--disable-sandbox','--continue','--session']:self.assertNotIn(arg,args)
 def test_bad_model(self):
  with self.assertRaises(Denied):cli_arguments('minimax','MiniMax-M3')
 def test_tool(self):
  for a in ['minimax','muse']:
   fs=frames(a)
   if a=='minimax':fs[3]['item']['type']='tool_call'
   else:fs[6]['payload']['event']['task_kind']='shell'
   with self.assertRaises(Denied):self.parse(a,fs)
 def test_child(self):
  fs=frames('muse');fs[9]['payload']['event']['parent_task_id']='child'
  with self.assertRaises(Denied):self.parse('muse',fs)
 def test_retry(self):
  fs=frames('muse');fs[11]['payload']['event']['details']['facets'][0]['attempt']=2
  with self.assertRaises(Denied):self.parse('muse',fs)
 def test_model_mismatch(self):
  fs=frames('muse');fs[2]['payload']['model_id']='other'
  with self.assertRaises(Denied):self.parse('muse',fs)
  fs=frames('minimax');fs[-1]['result']['model']['providerId']='minimax_api'
  with self.assertRaises(Denied):self.parse('minimax',fs)
 def test_sequence(self):
  fs=frames('minimax');fs[1]['sequence']=1
  with self.assertRaises(Denied):self.parse('minimax',fs)
 def test_after_terminal(self):
  fs=frames('minimax');extra=copy.deepcopy(fs[-1]);extra['sequence']+=1;fs.append(extra)
  with self.assertRaises(Denied):self.parse('minimax',fs)
 def test_timeout(self):
  with self.assertRaises(Denied):fixture_exec(request(),[sys.executable,'-c','import time;time.sleep(5)'],deadline=.05)
 def test_cancel(self):
  stop=threading.Event();stop.set()
  with self.assertRaises(Denied):fixture_exec(request(),[sys.executable,'-c','import time;time.sleep(5)'],cancel=stop)
 def test_exec_fixture(self):
  cmd=[sys.executable,'-c','import sys;sys.stdin.read();print(open('+repr(str(ROOT/'fixtures/minimax-success.jsonl'))+').read(),end="")']
  self.assertEqual(fixture_exec(request(),cmd)['text'],'offline probe')
 def fixture_command(self, adapter='minimax', final_newline=True, extra=b'', exit_code=0):
  body=(ROOT/'fixtures'/(adapter+'-success.jsonl')).read_bytes().rstrip(b'\n')
  if final_newline:body+=b'\n'
  body+=extra
  return [sys.executable,'-c','import sys;sys.stdin.buffer.read();sys.stdout.buffer.write('+repr(body)+');sys.stdout.flush();sys.exit('+str(exit_code)+')']
 def test_final_frame_without_newline(self):
  self.assertEqual(fixture_exec(request(),self.fixture_command(final_newline=False))['text'],'offline probe')
 def test_final_frame_without_newline_muse(self):
  r=request();r['adapter']='muse';r['model']=MUSE_MODEL
  self.assertEqual(fixture_exec(r,self.fixture_command(adapter='muse',final_newline=False))['text'],'offline probe')
 def test_invalid_trailing_frame_refused(self):
  with self.assertRaises(Denied):fixture_exec(request(),self.fixture_command(extra=b'{'))
 def test_event_after_terminal_refused_at_eof(self):
  extra=copy.deepcopy(frames('minimax')[-1]);extra['sequence']+=1
  with self.assertRaises(Denied):fixture_exec(request(),self.fixture_command(extra=json.dumps(extra).encode()))
 def test_closed_stdout_live_child_is_incomplete_denial(self):
  body=(ROOT/'fixtures/minimax-success.jsonl').read_bytes()
  cmd=[sys.executable,'-c','import sys,os,time;sys.stdin.buffer.read();os.write(1,'+repr(body)+');os.close(1);time.sleep(10)']
  with self.assertRaisesRegex(Denied,'exec incomplete'):fixture_exec(request(),cmd)
 def test_nonzero_exit_refused_despite_completed_event(self):
  with self.assertRaises(Denied):fixture_exec(request(),self.fixture_command(final_newline=False,exit_code=1))
 def test_cli_approval_bypass_flags_absent(self):
  for adapter,model in [('minimax',MINIMAX_MODEL),('muse',MUSE_MODEL)]:
   args=cli_arguments(adapter,model)
   for flag in ['--disable-approval','--yolo','--approval-judge']:
    self.assertNotIn(flag,args)
   self.assertNotIn('never',args)
   if '--permission' in args:self.assertNotEqual(args[args.index('--permission')+1],'off')
  args=cli_arguments('minimax',MINIMAX_MODEL)
  self.assertEqual(args[args.index('--permission')+1],'smart')
 def test_unqualified_empty_tools_refuses_before_spawn(self):
  for value in [False,None,1,'true']:
   with patch('exec_adapters.subprocess.Popen') as spawn:
    with self.assertRaisesRegex(Denied,'empty-tool inventory not qualified'):
     run_exec(request(),['not-a-launcher'],empty_tool_inventory_verified=value)
    spawn.assert_not_called()
 def test_request_cannot_supply_inventory_qualification(self):
  r=request();r['empty_tool_inventory_verified']=True
  with patch('exec_adapters.subprocess.Popen') as spawn:
   with self.assertRaisesRegex(Denied,'empty-tool inventory not qualified'):
    run_exec(r,['not-a-launcher'])
   spawn.assert_not_called()
 def test_output_cap(self):
  with self.assertRaises(Denied):fixture_exec(request(),[sys.executable,'-c','print("x"*1000001)'])
if __name__=='__main__':unittest.main()
