"""Read only the official CLI /usage screen. Never read or export credentials."""
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time

master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 100, 160, 0, 0))
def attach_terminal():
    os.setsid()
    fcntl.ioctl(0, termios.TIOCSCTTY, 0)

proc = subprocess.Popen([sys.argv[1], '--safe-mode', '--tools', '', '--permission-mode', 'dontAsk'],
                        stdin=slave, stdout=slave, stderr=slave, preexec_fn=attach_terminal)
os.close(slave)
def interrupted(signum, frame):
    raise SystemExit(1)
signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGINT, interrupted)
raw = ''
sent = False
trusted = False
trust_seen = 0
trust_moved = False
last_page = 0
start = time.monotonic()
plain = ''
result = {'ok': False, 'reason': 'Claude의 유료 추가 사용 설정을 확인하지 못했습니다. 요청을 보내지 않았습니다.'}
try:
    while time.monotonic() - start < 25:
        ready, _, _ = select.select([master], [], [], 0.2)
        if ready:
            try:
                raw += os.read(master, 65536).decode('utf-8', errors='replace')
            except OSError:
                break
        # Cursor positioning introduces spacing between words in Ink's terminal UI.
        plain = re.sub(r'\x1b\[[0-9;?<>]*[A-Za-z]', ' ', raw)
        plain = re.sub(r'\x1b\][^\x07]*\x07', '', plain)
        plain = re.sub(r'\s+', ' ', plain)
        if not trusted and ('Accessing' in plain and 'trust' in plain or trust_seen):
            if not trust_seen:
                trust_seen = time.monotonic()
            # Wait for the initial terminal render to settle before selecting.
            if time.monotonic() - trust_seen > 1:
                selections = re.findall(r'❯\s+(Yes|No)', plain)
                if selections and selections[-1] == 'Yes':
                    os.write(master, b'\r')
                    trusted = True
                    raw = ''
                elif selections and not trust_moved:
                    os.write(master, b'\x1b[B')
                    trust_moved = True
                    raw = ''
            continue
        if not sent and ('Safe mode:' in plain or 'customizations' in plain) and time.monotonic() - start > 2:
            os.write(master, b'/usage\r')
            sent = True
            last_page = time.monotonic()
            raw = ''
        if sent:
            if re.search(r'(Usage credits|Extra usage|credits)\s+are off|Extra usage is (?:not enabled|disabled)', plain, re.I):
                result = {'ok': True, 'extraUsageEnabled': False, 'source': 'Claude Code /usage', 'checkedAt': time.time()}
                break
            if re.search(r'(Usage credits|Extra usage).*?(?:are on|is enabled|enabled)', plain, re.I):
                result = {'ok': False, 'reason': 'Claude의 유료 추가 사용이 켜져 있습니다. Claude 설정에서 끈 뒤 연결을 다시 확인해 주세요.'}
                break
            if time.monotonic() - last_page > 2:
                os.write(master, b'\x1b[6~')
                last_page = time.monotonic()
finally:
    if proc.poll() is None:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except PermissionError:
            # macOS can reject a process-group signal after a CLI exits.
            try:
                proc.terminate()
            except (ProcessLookupError, PermissionError):
                pass
        except ProcessLookupError:
            pass
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            try:
                proc.kill()
            except (ProcessLookupError, PermissionError):
                pass
    os.close(master)
if len(sys.argv) > 2 and sys.argv[2] == '--diagnose' and not result['ok']:
    result['diagnostic'] = plain[-9000:]
print(json.dumps(result, ensure_ascii=False))
