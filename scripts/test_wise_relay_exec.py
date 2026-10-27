import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('wise_relay', Path(__file__).with_name('wise-relay-exec.py'))
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)

class AdapterTests(unittest.TestCase):
    def config(self):
        return {'WISE_GIT_RELAY_BEARER':'sbt_fake', 'WISE_GIT_RELAY_URL':'https://relay.example.test',
                'WISE_GIT_RELAY_REPOSITORY':w.REPO, 'WISE_GIT_RELAY_EXPECTED_ACTOR':w.ACTOR,
                'WISE_GIT_RELAY_PERMISSIONS':json.dumps(w.PERMISSIONS)}
    def test_config_map(self):
        self.assertEqual(w.configuration(self.config()), self.config())
    def test_config_list(self):
        self.assertEqual(w.configuration([{'key':k,'value':v} for k,v in self.config().items()]),self.config())
    def test_duplicate(self):
        with self.assertRaises(w.Refused):w.configuration([{'key':'x','value':'a'},{'key':'x','value':'b'}])
    def test_config_requires_exact_keys(self):
        for extra in [True,False]:
            c=self.config()
            if extra:c['X']='x'
            else:c.pop('WISE_GIT_RELAY_BEARER')
            with self.assertRaises(w.Refused):w.configuration(c)
    def test_repo_actor_perms(self):
        for k,v in [('WISE_GIT_RELAY_REPOSITORY','other/Repo'),('WISE_GIT_RELAY_EXPECTED_ACTOR','jaywedgeworth22'),('WISE_GIT_RELAY_PERMISSIONS','{}')]:
            c=self.config();c[k]=v
            with self.assertRaises(w.Refused):w.configuration(c)
    def test_relay_origin(self):
        for u in ['http://relay.test','https://x@y.test','https://y.test/other','https://y.test/?token=secret']:
            c=self.config();c['WISE_GIT_RELAY_URL']=u
            with self.assertRaises(w.Refused):w.configuration(c)
    def run_mint(self,login=w.ACTOR,ttl=3590,slug='swu-wise',token='ghs_fake'):
        calls=[]
        def request(url,headers,body):
            calls.append((url,headers,body))
            if len(calls)==1:return {'app_slug':slug,'token':token,'expires_in_seconds':ttl}
            return {'data':{'viewer':{'login':login}}}
        return w.mint_verified(self.config(),request),calls
    def test_mint_verified(self):
        token,calls=self.run_mint()
        self.assertEqual(token,'ghs_fake');self.assertEqual(len(calls),2)
        self.assertEqual(calls[0][2],{'repo':w.REPO,'permissions':w.PERMISSIONS})
        self.assertEqual(calls[1][0],'https://api.github.com/graphql')
        self.assertNotIn('sbt_fake',str(calls[1]))
    def test_no_personal_or_echo_principal(self):
        for name in ['jaywedgeworth22','swu-echo[bot]','github-actions[bot]',None]:
            with self.assertRaises(w.Refused):self.run_mint(login=name)
    def test_token_bounds(self):
        for kwargs in [{'ttl':1},{'ttl':3601},{'ttl':True},{'slug':'swu-echo'},{'token':'ghp_fake'}]:
            with self.assertRaises(w.Refused):self.run_mint(**kwargs)

    def test_null_or_malformed_graphql_viewer_fails_closed(self):
        for response in [None, {}, {'data':None}, {'data':{'viewer':None}}, {'data':[]}, {'data':{'viewer':[]} }]:
            calls=[]
            def request(*args):
                calls.append(args)
                return {'app_slug':'swu-wise','token':'ghs_fake','expires_in_seconds':3590} if len(calls)==1 else response
            with self.assertRaises(w.Refused):w.mint_verified(self.config(),request)
    def test_environment_export_mode_is_refused_before_fetch(self):
        from unittest.mock import patch
        with patch.object(w.sys,'argv',['wise-relay-exec.py','--github-env']), patch.object(w.subprocess,'run') as run:
            with self.assertRaises(w.Refused):w.main()
            run.assert_not_called()

if __name__=='__main__':unittest.main()
