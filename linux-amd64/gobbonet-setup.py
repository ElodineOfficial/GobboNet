#!/usr/bin/env python3
"""Linux setup shell around the Go password and verified model-download APIs.
The Go engine remains the owner of configuration, authentication and downloads.
"""
import hashlib
import http.server
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import subprocess
import sys
import threading
import urllib.error
import urllib.request

PREFIX = Path(__file__).resolve().parent
BIN = str(PREFIX / 'gobbonet')
ENGINE = sys.argv[1] if len(sys.argv) > 1 else ''
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
child = None
upstream = ''
mode = ''
extra = {'state': 'idle'}
lock = threading.RLock()

def cli(*args, data=None):
    p = subprocess.run([BIN, *args], input=data, text=True, capture_output=True)
    if p.returncode:
        raise ValueError(p.stderr.strip() or p.stdout.strip())
    return p.stdout.strip()

def get(key):
    return cli('config', 'get', key)

def put(key, value):
    cli('config', 'set', key, str(value))

def start():
    global child, upstream
    if child is not None:
        child.terminate()
        child.wait(timeout=10)
    child = subprocess.Popen([BIN, 'setup', '--force', '--no-browser', '--catalog',
                              str(PREFIX / 'models.ini'), '--server-exe', ENGINE],
                             stdout=subprocess.PIPE, stderr=sys.stderr, text=True)
    for line in child.stdout:
        match = re.search(r'http://127\.0\.0\.1:\d+/', line)
        if match:
            upstream = match.group(0)
            return
    raise RuntimeError('Setup could not start. See the launch log.')

def proxy(path, body=None):
    req = urllib.request.Request(upstream.rstrip('/') + path, data=body,
                                 headers={'Content-Type': 'application/json'})
    try:
        with OPENER.open(req, timeout=90) as res:
            return res.status, json.load(res)
    except urllib.error.HTTPError as e:
        return e.code, json.load(e)

def nomic():
    global extra
    dest = Path(get('data_dir')) / 'embeddings'
    dest.mkdir(parents=True, exist_ok=True)
    final = dest / 'nomic-embed-text-v1.5.Q8_0.gguf'
    part = final.with_suffix('.part')
    expected = '3e24342164b3d94991ba9692fdc0dd08e3fd7362e0aacc396a9a5c54a544c3b7'
    try:
        if shutil.disk_usage(dest).free < 400 * 1024**2:
            raise ValueError('Nomic needs at least 400 MB free.')
        url = 'https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF/resolve/main/' + final.name
        digest = hashlib.sha256()
        with urllib.request.urlopen(url, timeout=60) as response, part.open('wb') as out:
            total = int(response.headers.get('Content-Length', 0))
            done = 0
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                out.write(chunk)
                digest.update(chunk)
                done += len(chunk)
                extra = dict(state='running', done=done, total=total,
                             percent=done * 100 / total if total else 0)
        if digest.hexdigest() != expected:
            raise ValueError('Nomic checksum mismatch. Retry the download.')
        part.replace(final)
        extra = dict(state='done', message='Nomic downloaded and verified.')
    except Exception as e:
        part.unlink(missing_ok=True)
        extra = dict(state='error', message=str(e))

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, code, body):
        payload = json.dumps(body).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if self.headers.get('Host') != f'127.0.0.1:{self.server.server_port}':
            self.reply(403, {'error': 'Local setup only.'})
            return
        if self.path == '/':
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('X-Frame-Options', 'DENY')
            self.end_headers()
            self.wfile.write((PREFIX / 'wizard.html').read_bytes())
            return
        try:
            if self.path == '/api/extras':
                self.reply(200, extra)
            elif self.path == '/api/state':
                code, state = proxy(self.path)
                state.update(data_dir=get('data_dir'), listen_port=int(get('listen_port')),
                             model_dir=get('model_dir'))
                self.reply(code, state)
            elif self.path == '/api/download':
                self.reply(*proxy(self.path))
            else:
                self.reply(404, {'error': 'Not found'})
        except Exception as e:
            self.reply(500, {'error': str(e)})

    def do_POST(self):
        global mode, extra
        origin = f'http://127.0.0.1:{self.server.server_port}'
        if (self.headers.get('Host') != origin[7:] or
            self.headers.get('Origin', origin) != origin or
            self.headers.get('Content-Type', '').split(';')[0] != 'application/json'):
            self.reply(403, {'error': 'Use the local setup page.'})
            return
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 1048576:
                raise ValueError('Invalid request size')
            body = self.rfile.read(size)
            req = json.loads(body)
            with lock:
                if self.path == '/api/location':
                    path = Path(req['path']).expanduser()
                    if not path.is_absolute():
                        raise ValueError('Choose an absolute folder path.')
                    if path != Path(get('data_dir')) and (Path(get('data_dir')) / 'setup-complete.json').exists():
                        raise ValueError('Existing installation: keep this folder to preserve your data. Move it separately before changing it.')
                    path.mkdir(parents=True, exist_ok=True, mode=0o700)
                    probe = path / '.gobbonet-write-test'
                    with probe.open('x') as out:
                        out.write('test')
                    probe.unlink()
                    put('data_dir', path)
                    put('model_dir', path / 'models')
                    start()
                    self.reply(200, {'ok': True})
                elif self.path == '/api/port':
                    port = int(req['port'])
                    if not 1024 <= port <= 65535 or port in (11436, 11437):
                        raise ValueError('Choose a port from 1024 to 65535, except engine ports 11436 and 11437.')
                    with socket.socket() as sock:
                        sock.bind(('0.0.0.0', port))
                    put('listen_port', port)
                    start()
                    self.reply(200, {'ok': True})
                elif self.path == '/api/extras':
                    if mode != 'local':
                        raise ValueError('Choose a local engine first.')
                    if extra['state'] != 'running':
                        extra = {'state': 'running', 'done': 0, 'total': 0}
                        threading.Thread(target=nomic, daemon=True).start()
                    self.reply(200, {'ok': True})
                elif self.path in ('/api/password', '/api/backend', '/api/download', '/api/finish'):
                    if self.path == '/api/backend' and req.get('mode') == 'remote':
                        put('server_exe', '')
                    if self.path == '/api/finish':
                        if mode not in ('local', 'remote'):
                            raise ValueError('Choose a backend first.')
                        if extra['state'] == 'running':
                            raise ValueError('Wait for the Nomic download to finish.')
                        if mode == 'local':
                            code, download = proxy('/api/download')
                            if download.get('state') in ('running', 'error'):
                                raise ValueError('Finish or retry the model download first.')
                            models = list(Path(get('model_dir')).glob('*.gguf'))
                            valid = False
                            for model in models:
                                with model.open('rb') as f:
                                    valid |= f.read(4) == b'GGUF' and model.stat().st_size > 1024
                            if not valid:
                                raise ValueError('Download a model, or put your GGUF in ' + get('model_dir'))
                    result = proxy(self.path, body)
                    if self.path == '/api/backend' and result[0] == 200:
                        mode = req['mode']
                    if self.path == '/api/finish' and result[0] == 200 and req.get('autostart'):
                        desktop = Path(os.environ.get('XDG_CONFIG_HOME', str(Path.home() / '.config'))) / 'autostart/gobbonet.desktop'
                        launcher = str(PREFIX / 'gobbonet-launch')
                        escaped = launcher.replace('\\', '\\\\').replace('"', '\\"').replace('`', '\\`').replace('$', '\\$').replace('%', '%%')
                        try:
                            text = desktop.read_text()
                            text = re.sub(r'^Exec=.*$', lambda _: 'Exec="' + escaped + '" --no-browser', text, flags=re.M)
                            desktop.write_text(text)
                        except OSError as e:
                            print('Autostart could not be updated: ' + str(e), file=sys.stderr)
                    self.reply(*result)
                    if self.path == '/api/finish' and result[0] == 200:
                        threading.Thread(target=self.server.shutdown, daemon=True).start()
                else:
                    self.reply(404, {'error': 'Not found'})
        except Exception as e:
            self.reply(400, {'error': str(e)})

if __name__ == '__main__':
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    signal.signal(signal.SIGINT, lambda *_: sys.exit(130))
    try:
        start()
        with http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler) as server:
            print(f'GobboNet setup is at: http://127.0.0.1:{server.server_port}/', flush=True)
            server.serve_forever()
    finally:
        if child is not None and child.poll() is None:
            child.terminate()
            child.wait(timeout=10)
