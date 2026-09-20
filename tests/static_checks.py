#!/usr/bin/env python3
"""Static checks on pw_trace.js — no browser, no Odoo, runs anywhere.

These catch the classes of breakage that `node --check` cannot:
  * stray NUL/control bytes in the source (legal JS, silently corrupts a string —
    this actually happened: a NUL ended up inside a selector literal and only
    turned up by chance)
  * a command documented in the in-REPL help but never implemented, or vice versa
  * two dispatcher branches claiming the same command (the second is dead code)
"""
import re
import json
import sys

PATH = 'pw_trace.js'
fails, warns = [], []

src = open(PATH, encoding='utf-8').read()

# --- 1. stray control characters --------------------------------------------
bad = [(i, repr(ch)) for i, ch in enumerate(src)
       if ord(ch) < 32 and ch not in '\n\t']
if bad:
    line = src[:bad[0][0]].count('\n') + 1
    fails.append("%d stray control char(s); first is %s on line %d"
                 % (len(bad), bad[0][1], line))

# --- 2. duplicate dispatcher branches ---------------------------------------
implemented = re.findall(r"cmd === '([a-z0-9]+)'", src)
dupes = sorted({c for c in implemented if implemented.count(c) > 1})
if dupes:
    fails.append("command implemented more than once (second branch is dead): %s"
                 % ', '.join(dupes))
implemented = set(implemented)

# --- 3. command registry <-> implementation parity --------------------------
commands = json.load(open('commands.json', encoding='utf-8'))
helped = {command['name'] for command in commands}
if len(helped) != len(commands):
    fails.append('duplicate command registry entries')

undocumented = sorted(implemented - helped)
unimplemented = sorted(helped - implemented)
if unimplemented:
    fails.append("in the help text but NOT implemented: %s" % ', '.join(unimplemented))
if undocumented:
    warns.append("implemented but missing from the help text: %s" % ', '.join(undocumented))

# --- 4. every warn helper names a real command ------------------------------
for name in sorted(set(re.findall(r"warnIfWrapped\('(\w+)'", src))):
    if name not in implemented:
        fails.append("warnIfWrapped('%s') names a command that does not exist" % name)

# --- report ------------------------------------------------------------------
print("  %d commands implemented, %d documented in help" % (len(implemented), len(helped)))
for w in warns:
    print("  WARN  %s" % w)
for f in fails:
    print("  FAIL  %s" % f)
if not fails:
    print("  static checks OK")
sys.exit(1 if fails else 0)
