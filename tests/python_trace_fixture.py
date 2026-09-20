"""An instrumented WSGI service for end-to-end browser correlation tests."""
import importlib.util
import json
from pathlib import Path
import sys
from wsgiref.simple_server import make_server
spec=importlib.util.spec_from_file_location('observer',Path(__file__).resolve().parents[1]/'server_addons/tracekit_runtime/observer.py')
observer=importlib.util.module_from_spec(spec);spec.loader.exec_module(observer)
state=Path(sys.argv[1]);state.mkdir(exist_ok=True);(state/'key').write_bytes(b't'*32)
ns={'__name__':'odoo.addons.trace_test.models'}
exec(compile('''class Base:
    _name = 'fixture.model'
    def action_test(self):
        return 5
class Custom(Base):
    def action_test(self):
        return super().action_test() + 2
''','fixture/overrides.py','exec'),ns)
class App:
    def __call__(self,env,start):
        if env['PATH_INFO'].startswith('/web/dataset/'):
            body=json.loads(env['wsgi.input'].read(int(env['CONTENT_LENGTH'])))
            result=ns['Custom']().action_test()
            start('200 OK',[('Content-Type','application/json')])
            return [json.dumps({'jsonrpc':'2.0','id':body['id'],'result':result}).encode()]
        start('200 OK',[('Content-Type','text/html')]);return [b'<html><body>Fixture</body></html>']
App.__call__=observer.wrap(App.__call__,b't'*32,state/'traces')
server=make_server('127.0.0.1',0,App());Path(sys.argv[2]).write_text(str(server.server_port));server.serve_forever()
