"""Bounded thread-local call tracing for signed dataset requests (Odoo 14/17/19)."""
import hashlib
import hmac
import json
import logging
import os
from pathlib import Path
import re
import sys
import time
import uuid

_LOG = logging.getLogger(__name__)
KIT = Path(__file__).resolve().parents[2]
STATE = Path(os.environ.get('TRACEKIT_STATE_DIR', str(KIT / '.runtime')))
ID = re.compile(r'^[a-zA-Z0-9_-]{1,110}$')


class Calls:
    def __init__(self, max_calls=2000, max_seconds=10):
        self.calls = []
        self.stack = {}
        self.order = []
        self.max_calls = max_calls
        self.deadline = time.perf_counter() + max_seconds
        self.truncated = False
        self.db = None

    def profile(self, frame, event, arg):
        try:
            if time.perf_counter() > self.deadline:
                self.truncated = True
                sys.setprofile(None)
                return
            if event == 'call':
                module = frame.f_globals.get('__name__', '')
                if not (module.startswith('odoo.addons.') or module == 'odoo.models' or module.startswith('odoo.orm.')):
                    return
                if module.startswith('odoo.addons.tracekit_runtime'):
                    return
                if len(self.calls) >= self.max_calls:
                    self.truncated = True
                    return
                obj = frame.f_locals.get('self')
                model = getattr(type(obj), '_name', None) if obj is not None else None
                if not isinstance(model, str):
                    model = None
                if model and self.db is None:
                    try:
                        self.db = obj.env.cr.dbname
                    except Exception:
                        pass
                code = frame.f_code
                call = {'id': len(self.calls) + 1, 'parent_id': self.order[-1] if self.order else None,
                        'module': module, 'model': model, 'function': getattr(code, 'co_qualname', code.co_name),
                        'file': code.co_filename, 'line': code.co_firstlineno, 'duration_ms': None,
                        'complete': False}
                self.calls.append(call)
                self.stack[id(frame)] = (call, time.perf_counter())
                self.order.append(call['id'])
            elif event == 'return':
                entry = self.stack.pop(id(frame), None)
                if entry:
                    call, start = entry
                    call['duration_ms'] = round((time.perf_counter() - start) * 1000, 3)
                    call['complete'] = True
                    if self.order and self.order[-1] == call['id']:
                        self.order.pop()
        except Exception:
            # Observation must not change business behavior.
            self.truncated = True


def signed_request(environ, key):
    if environ.get('REQUEST_METHOD') != 'POST' or not environ.get('PATH_INFO', '').startswith('/web/dataset/'):
        return None
    values = [environ.get('HTTP_X_TRACEKIT_' + part, '') for part in ('RUN', 'REQUEST', 'STEP')]
    if not all(ID.fullmatch(value) for value in values):
        return None
    run, request_id, step = values
    try:
        uuid.UUID(run)
    except ValueError:
        return None
    if not request_id.startswith(run + '-rpc-') or not step.startswith(run + '-step-'):
        return None
    signature = hmac.new(key, '\n'.join(values).encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(signature, environ.get('HTTP_X_TRACEKIT_SIGNATURE', '')):
        return None
    return run, request_id, step


def wrap(original, key, directory):
    def observed(self, environ, start_response):
        identity = signed_request(environ, key)
        if not identity:
            return original(self, environ, start_response)
        # Never replace an existing profiler or profile a greenlet-shared thread.
        try:
            import gevent.monkey
            gevent_thread = gevent.monkey.is_module_patched('threading')
        except Exception:
            # Not just ImportError: a gevent built against another greenlet
            # raises ValueError ("greenlet.greenlet size changed") on import.
            # That must not break every signed request; a broken gevent cannot
            # have patched threading anyway.
            gevent_thread = False
        skipped = 'An existing profiler is active' if sys.getprofile() else 'Gevent worker is not supported' if gevent_thread else None
        run, request_id, step = identity
        calls = Calls()
        start = time.perf_counter()
        previous = sys.getprofile()
        record = {'schema_version': 1, 'run_id': run, 'request_id': request_id, 'step_id': step,
                  'pid': os.getpid(), 'endpoint': environ.get('PATH_INFO'), 'status': 'skipped' if skipped else 'captured',
                  'note': skipped, 'calls': calls.calls}
        def response(status, headers, exc_info=None):
            record['http_status'] = status.split(' ', 1)[0]
            return start_response(status, headers, exc_info)
        try:
            if not skipped:
                sys.setprofile(calls.profile)
            # Dataset JSON responses are constructed synchronously in Odoo's WSGI call.
            # Streaming iterator execution is intentionally outside this capture.
            return original(self, environ, response)
        finally:
            if not skipped:
                intact = sys.getprofile() == calls.profile
                sys.setprofile(previous)
                record['status'] = 'partial' if calls.truncated or not intact or calls.stack else 'captured'
            record.update(duration_ms=round((time.perf_counter() - start) * 1000, 3), db=calls.db,
                          truncated=calls.truncated, scope='Python addon and ORM calls during WSGI dispatch; inclusive timings; no locals or SQL values')
            try:
                target = directory / run
                target.mkdir(parents=True, exist_ok=True, mode=0o700)
                final = target / (request_id + '.json')
                tmp = target / (request_id + '.' + uuid.uuid4().hex + '.tmp')
                tmp.write_text(json.dumps(record))
                tmp.replace(final)
            except Exception:
                _LOG.exception('Unable to save tracekit runtime evidence')
    return observed


def post_load():
    import odoo.http
    cls = type(odoo.http.root)
    if getattr(cls, '_tracekit_observer', False):
        return
    try:
        key = (STATE / 'key').read_bytes()
        if len(key) != 32:
            raise ValueError('Expected a 32-byte key')
    except (OSError, ValueError):
        _LOG.warning('Tracekit runtime disabled: run server-trace.py enable first')
        return
    cls.__call__ = wrap(cls.__call__, key, STATE / 'traces')
    cls._tracekit_observer = True
    _LOG.info('Tracekit runtime observer ready (signed requests only)')
