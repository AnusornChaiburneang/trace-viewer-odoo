#!/usr/bin/env python3
"""Enable/disable the server-wide observer in an Odoo config, preserving other options."""
import argparse
import configparser
import os
from pathlib import Path
import re
import secrets
import shutil
import time

KIT = Path(__file__).resolve().parent


def update_option(text, key, value):
    pattern = re.compile(r'^' + re.escape(key) + r'\s*=.*(?:\n[ \t]+[^\n]*)*', re.M)
    if pattern.search(text):
        return pattern.sub(lambda _: key + ' = ' + value, text, count=1)
    return text.rstrip() + '\n' + key + ' = ' + value + '\n'


def configure(text, enabled):
    parser = configparser.RawConfigParser()
    parser.read_string(text)
    paths = [p.strip() for p in parser.get('options', 'addons_path', fallback='').split(',') if p.strip()]
    modules = [p.strip() for p in parser.get('options', 'server_wide_modules', fallback='base,web').split(',') if p.strip()]
    addon_path = str(KIT / 'server_addons')
    if enabled:
        if not paths:
            raise ValueError('Explicit addons_path is required; preserve your current addon paths first')
        if addon_path not in paths:
            paths.append(addon_path)
        if 'tracekit_runtime' not in modules:
            modules.append('tracekit_runtime')
    else:
        paths = [p for p in paths if p != addon_path]
        modules = [m for m in modules if m != 'tracekit_runtime']
    text = update_option(text, 'addons_path', ', '.join(paths))
    return update_option(text, 'server_wide_modules', ','.join(modules))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['enable', 'disable', 'status'])
    parser.add_argument('--config', required=True)
    args = parser.parse_args()
    path = Path(args.config).resolve()
    old = path.read_text()
    if args.action == 'status':
        config = configparser.RawConfigParser(); config.read_string(old)
        modules = config.get('options', 'server_wide_modules', fallback='base,web').split(',')
        print('Configured: ' + ('enabled' if 'tracekit_runtime' in [m.strip() for m in modules] else 'disabled'))
        print('Config state is not proof that the running process loaded the observer.')
        return
    new = configure(old, args.action == 'enable')
    state = Path(os.environ.get('TRACEKIT_STATE_DIR', str(KIT / '.runtime'))); state.mkdir(mode=0o700, exist_ok=True)
    if args.action == 'enable':
        key = state / 'key'
        if not key.exists():
            fd = os.open(str(key), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'wb') as out:
                out.write(secrets.token_bytes(32))
    if new != old:
        backups = state / 'config-backups'; backups.mkdir(mode=0o700, exist_ok=True)
        backup = backups / (path.parent.name + '-' + path.name + '-' + str(time.time_ns()) + '.bak')
        shutil.copy2(str(path), str(backup))
        backup.chmod(0o600)
        path.write_text(new)
        print('Updated config; backup: ' + str(backup))
    print('Restart through /home/server/dev-dashboard/cli.py odoo restart to apply.')
    print('Then record with trace-local.sh ... --python-trace. Unmarked requests are not profiled.')


if __name__ == '__main__':
    main()
