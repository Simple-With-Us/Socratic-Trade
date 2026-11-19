import copy,json,sys,threading,unittest,uuid
from broker import Broker,Denied,Rpc,validate,CAPS

def request():return dict(version=1,requestId=str(uuid.uuid4()),ownerUserId='owner',adapter='minimax',model='m1',messages=[dict(role='user',content='hi')],maxOutputTokens=100,capabilities=CAPS)
class Tests(unittest.TestCase):
 def setUp(self):self.b=Broker('owner','token',{'minimax':['m1']},lambda d:dict(version=1,text='ok',finishReason='stop'))
 def test_happy(self):self.assertEqual(self.b.generate('Bearer token',request())['text'],'ok')
 def test_auth(self):
  for auth in ('','Bearer wrong'):
   with self.assertRaises(Denied):self.b.generate(auth,request())
 def test_tenant(self):
  r=request();r['ownerUserId']='tenant'
  with self.assertRaises(Denied):self.b.generate('Bearer token',r)
 def test_replay(self):
  r=request();self.b.generate('Bearer token',r)
  with self.assertRaises(Denied):self.b.generate('Bearer token',r)
 def test_fields(self):
  for k,v in [('cwd','/root'),('sessionId','steal'),('command','sh'),('env',{})]:
   r=request();r[k]=v
   with self.assertRaises(Denied):self.b.generate('Bearer token',r)
 def test_bad_inputs(self):
  for k,v in [('capabilities',{}),('model','wrong'),('messages',[dict(role='tool',content='x')]),('maxOutputTokens',True),('messages',[dict(role='user',content='x'*1000001)])]:
   r=request();r[k]=v
   with self.assertRaises(Denied):self.b.generate('Bearer token',r)
 def test_busy(self):
  self.b.lock.acquire()
  try:
   with self.assertRaises(Denied):self.b.generate('Bearer token',request())
  finally:self.b.lock.release()
 def test_bad_result(self):
  self.b.runner=lambda d:dict(version=1,text='x',finishReason='stop',token='secret')
  with self.assertRaises(Denied):self.b.generate('Bearer token',request())
 def test_tool_frames(self):
  for frame in [dict(method='session/request_permission',id=1),dict(method='session/update',params=dict(update=dict(sessionUpdate='tool_call'))),dict(method='item/started',params=dict(item=dict(kind='toolCall')))]:
   r=Rpc([sys.executable,'-c','import json;print('+repr(json.dumps(frame))+',flush=True)'])
   try:
    with self.assertRaises(Denied):r.read()
   finally:r.close()
 def test_timeout(self):
  r=Rpc([sys.executable,'-c','import time;time.sleep(10)'],deadline=.05)
  try:
   with self.assertRaises(Denied):r.read()
  finally:r.close()
if __name__=='__main__':unittest.main()
