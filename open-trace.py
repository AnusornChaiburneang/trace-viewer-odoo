#!/usr/bin/env python3
"""Open a dashboard trace through VS Code Remote using the server's Playwright."""
import argparse
import fcntl
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time
from urllib.parse import urlencode, urlsplit
from urllib.request import build_opener, ProxyHandler

KIT = Path(__file__).resolve().parent
PORT = 9323
HTTP = build_opener(ProxyHandler({}))


def viewer_ready():
    try:
        with HTTP.open(f'http://127.0.0.1:{PORT}/trace/index.html', timeout=1) as response:
            return b'<title>Playwright Trace Viewer</title>' in response.read(16384)
    except (OSError, ValueError):
        return False


def ensure_viewer():
    state = Path(os.environ.get('XDG_CACHE_HOME', str(Path.home() / '.cache'))) / 'odoo-trace-viewer'
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (state / 'launcher.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if viewer_ready():
            return
        with socket.socket() as probe:
            try:
                probe.bind(('127.0.0.1', PORT))
            except OSError:
                raise RuntimeError(f'Port {PORT} is occupied by another service. No process was stopped.')
        cli = KIT / 'node_modules/playwright/cli.js'
        node = shutil.which('node')
        if not node or not cli.is_file():
            raise RuntimeError('The trace kit needs Node.js and its installed Playwright package.')
        with (state / 'viewer.log').open('ab') as log:
            process = subprocess.Popen(
                [node, str(cli), 'show-trace', '--host', '127.0.0.1', '--port', str(PORT)],
                stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                start_new_session=True, env={**os.environ, 'CI': '1', 'CODEX_CI': '1'},
            )
        for _ in range(50):
            if viewer_ready():
                return
            if process.poll() is not None:
                break
            time.sleep(.1)
        if process.poll() is None:
            process.terminate()
        raise RuntimeError(f'Could not start Trace Viewer. See {state / "viewer.log"}.')


def ipc_hook_alive(path):
    if not path:
        return False
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as probe:
            probe.settimeout(2)
            probe.connect(path)
        return True
    except OSError:
        return False


def find_live_ipc_hook():
    # The env var this process inherited is frozen at whatever VS Code session was live when
    # the *dashboard server* started; it never updates on reconnect/reopen. So re-scan the
    # runtime dir every call and use whichever socket answers right now, newest first.
    candidates = []
    env_hook = os.environ.get('VSCODE_IPC_HOOK_CLI')
    if env_hook:
        candidates.append(Path(env_hook))
    try:
        run_dir = Path(f'/run/user/{os.getuid()}')
        candidates.extend(sorted(run_dir.glob('vscode-ipc-*.sock'), key=lambda p: p.stat().st_mtime, reverse=True))
    except OSError:
        pass
    seen = set()
    for candidate in candidates:
        key = str(candidate)
        if key in seen:
            continue
        seen.add(key)
        if ipc_hook_alive(key):
            return key
    return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('trace_url')
    parser.add_argument('--no-open', action='store_true', help='Print the viewer URL without opening a browser')
    args = parser.parse_args()
    url = urlsplit(args.trace_url)
    if url.scheme not in ('http', 'https') or not url.hostname or url.username or url.password:
        parser.error('Pass the plain HTTP(S) trace URL, without Markdown link formatting.')
    code = shutil.which('code')
    ipc_hook = None if args.no_open else find_live_ipc_hook()
    if not args.no_open and (not code or not ipc_hook):
        raise RuntimeError(
            'No VS Code Remote session is currently connected to serverpocket. '
            'Open (or reopen) VS Code connected to serverpocket, then retry — or pass '
            '--no-open to just get the viewer URL.'
        )
    # Check the artifact before opening a browser; never save or execute its contents.
    with HTTP.open(args.trace_url, timeout=15) as response:
        if response.read(4) != b'PK\x03\x04':
            raise RuntimeError('The selected artifact did not return a trace ZIP.')
    ensure_viewer()
    viewer = f'http://localhost:{PORT}/trace/index.html?' + urlencode({'trace': args.trace_url})
    if not args.no_open:
        try:
            subprocess.run(
                [code, '--openExternal', viewer], check=True, timeout=20,
                capture_output=True, text=True, env={**os.environ, 'VSCODE_IPC_HOOK_CLI': ipc_hook},
            )
        except subprocess.CalledProcessError as error:
            detail = (error.stderr or '').strip()
            if 'ECONNREFUSED' in detail or 'vscode-ipc' in detail:
                raise RuntimeError(
                    'The VS Code session went stale between checking and opening the trace. Retry.'
                ) from error
            raise RuntimeError(f'VS Code refused to open the trace: {detail or error}') from error
        print('Asked VS Code to open the selected trace in your browser.')
    print(viewer)


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, subprocess.SubprocessError) as error:
        print(f'Trace Viewer: {error}', file=sys.stderr)
        sys.exit(1)
