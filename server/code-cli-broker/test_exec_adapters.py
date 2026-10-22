import copy,json,pathlib,sys,threading,unittest
from exec_adapters import ExecState,cli_arguments,run_exec,MINIMAX_MODEL,MUSE_MODEL
from broker import Denied
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
  fs=frames('minimax');fs.append(copy.deepcopy(fs[-1]))
  with self.assertRaises(Denied):self.parse('minimax',fs)
 def test_timeout(self):
  with self.assertRaises(Denied):run_exec(request(),[sys.executable,'-c','import time;time.sleep(5)'],deadline=.05)
 def test_cancel(self):
  stop=threading.Event();stop.set()
  with self.assertRaises(Denied):run_exec(request(),[sys.executable,'-c','import time;time.sleep(5)'],cancel=stop)
 def test_exec_fixture(self):
  cmd=[sys.executable,'-c','import sys;sys.stdin.read();print(open('+repr(str(ROOT/'fixtures/minimax-success.jsonl'))+').read(),end="")']
  self.assertEqual(run_exec(request(),cmd)['text'],'offline probe')
 def test_output_cap(self):
  with self.assertRaises(Denied):run_exec(request(),[sys.executable,'-c','print("x"*1000001)'])
if __name__=='__main__':unittest.main()
