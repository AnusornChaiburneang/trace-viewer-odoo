import hashlib
import hmac
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
import uuid

ROOT=Path(__file__).resolve().parents[1]
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,str(path));mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod);return mod
observer=load('observer',ROOT/'server_addons/tracekit_runtime/observer.py')
config=load('configurer',ROOT/'server-trace.py')
namespace={'__name__':'odoo.addons.fixture.models'}
exec(compile('''class Base:
    _name = 'fixture.model'
    def work(self):
        return 7
class Override(Base):
    def work(self):
        return super().work() + 1
''','fixture/models.py','exec'),namespace)

class ObserverTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);self.key=b'x'*32
        run=str(uuid.uuid4());self.ids=[run,run+'-rpc-1',run+'-step-1']
        self.env=dict(REQUEST_METHOD='POST',PATH_INFO='/web/dataset/call_kw')
        self.env.update({'HTTP_X_TRACEKIT_'+k:v for k,v in zip(['RUN','REQUEST','STEP'],self.ids)})
        self.env['HTTP_X_TRACEKIT_SIGNATURE']=hmac.new(self.key,'\n'.join(self.ids).encode(),hashlib.sha256).hexdigest()
    def invoke(self,func,env=None):
        return observer.wrap(func,self.key,self.root)(None,env or self.env,lambda *a:None)
    def record(self):
        return json.loads(next(self.root.rglob('*.json')).read_text())
    def test_executed_override_chain_and_restore(self):
        def dispatch(*args):return namespace['Override']().work()
        before=sys.getprofile();self.assertEqual(self.invoke(dispatch),8);self.assertIs(sys.getprofile(),before)
        calls=self.record()['calls'];self.assertEqual(len(calls),2)
        self.assertEqual(calls[1]['parent_id'],calls[0]['id'])
        self.assertEqual(calls[0]['model'],'fixture.model');self.assertTrue(all(c['complete'] for c in calls))
        self.assertEqual(self.record()['status'],'captured')
    def test_exception_propagates_and_profile_restored(self):
        def dispatch(*args):raise ValueError('business exception')
        with self.assertRaisesRegex(ValueError,'business exception'):self.invoke(dispatch)
        self.assertIsNone(sys.getprofile());self.assertTrue(list(self.root.rglob('*.json')))
    def test_unsigned_request_is_untouched(self):
        self.env['HTTP_X_TRACEKIT_SIGNATURE']='wrong'
        self.assertEqual(self.invoke(lambda *a:9),9);self.assertFalse(list(self.root.rglob('*.json')))
    def test_existing_profiler_not_replaced(self):
        def profile(*a):pass
        sys.setprofile(profile)
        try:
            self.invoke(lambda *a:1);self.assertIs(sys.getprofile(),profile)
        finally:sys.setprofile(None)
        self.assertEqual(self.record()['status'],'skipped')
    def test_bounds(self):
        calls=observer.Calls(max_calls=1)
        sys.setprofile(calls.profile)
        try:namespace['Override']().work()
        finally:sys.setprofile(None)
        self.assertEqual(len(calls.calls),1);self.assertTrue(calls.truncated)
    def test_config_preserves_other_options_and_is_idempotent(self):
        source='[options]\n# keep comment\naddons_path = /one,\n /two\ndb_name = existing\n'
        enabled=config.configure(source,True)
        self.assertIn('db_name = existing',enabled);self.assertIn('# keep comment',enabled)
        self.assertEqual(config.configure(enabled,True),enabled)
        disabled=config.configure(enabled,False);self.assertNotIn('tracekit_runtime',disabled)
    def test_invalid_id(self):
        self.env['HTTP_X_TRACEKIT_RUN']='../../etc'
        self.assertIsNone(observer.signed_request(self.env,self.key))

if __name__=='__main__':unittest.main()
