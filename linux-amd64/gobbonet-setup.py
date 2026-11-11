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
import urllib.parse
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
added_dirs = []   # model_dirs entries this run added, so a changed mind takes them back

def cli(*args, data=None):
    p = subprocess.run([BIN, *args], input=data, text=True, capture_output=True)
    if p.returncode:
        raise ValueError(p.stderr.strip() or p.stdout.strip())
    return p.stdout.strip()

def get(key):
    return cli('config', 'get', key)

def put(key, value):
    cli('config', 'set', key, str(value))

def get_list(key):
    # --json, because a folder name can hold a space ("My Models") and the
    # plain form is space-separated (1.8.0, issue #68).
    return json.loads(cli('config', 'get', '--json', key))

def put_list(key, items):
    cli('config', 'set', key, json.dumps([str(i) for i in items]))

# What counts as a model is what the model menu lists (internal/models
# ScanDir): a .gguf file in any case, the first part of a split one only,
# no vision projector. A link counts when its target is there.
SPLIT = re.compile(r'(?i)^.*-(\d{5})-of-\d{5}\.gguf$')
SCAN_CAP = 5000   # entries read per folder; a scan answers a typed path, it must not crawl a disk
SUB_CAP = 200     # subfolders looked into, one level down

def model_files(folder):
    found = []
    try:
        with os.scandir(folder) as it:
            for i, e in enumerate(it):
                if i >= SCAN_CAP:
                    break
                name = e.name
                if not name.lower().endswith('.gguf') or 'mmproj' in name.lower():
                    continue
                m = SPLIT.match(name)
                if m and int(m.group(1)) != 1:
                    continue
                try:
                    if e.is_file():
                        found.append(Path(e.path))
                except OSError:
                    pass
    except OSError:
        pass
    return found

def count_models(folder):
    """GGUF models directly in folder, and in its subfolders one level down."""
    top = len(model_files(folder))
    sub = 0
    try:
        with os.scandir(folder) as it:
            looked = 0
            for e in it:
                if looked >= SUB_CAP:
                    break
                try:
                    if e.is_dir() and not e.name.startswith('.'):
                        looked += 1
                        sub += len(model_files(e.path))
                except OSError:
                    pass
    except OSError:
        pass
    return top, sub

def is_gguf(path):
    try:
        with path.open('rb') as f:
            return f.read(4) == b'GGUF' and path.stat().st_size > 1024
    except OSError:
        return False

def writable(folder, what):
    try:
        folder.mkdir(parents=True, exist_ok=True, mode=0o700)
        probe = folder / f'.gobbonet-write-test-{os.getpid()}'
        with probe.open('x') as out:
            out.write('test')
        probe.unlink()
    except OSError as e:
        raise ValueError(f'GobboNet cannot write to the {what} folder {folder}: {e.strerror or e}. '
                         'Choose a folder you own.')

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

def login_program():
    """What the login entry starts: this launcher -- or from an AppImage, the
    AppImage file. PREFIX is then inside the image's temporary mount, which is
    gone once GobboNet closes, so an entry naming it did nothing at the next
    login (1.7.8 to 1.8.0). The runtime gives APPIMAGE and APPDIR to everything
    it starts; PREFIX has to be inside APPDIR for them to be about GobboNet."""
    image, appdir = os.environ.get('APPIMAGE', ''), os.environ.get('APPDIR', '')
    if image and appdir and Path(appdir).resolve() in PREFIX.parents:
        return image
    return str(PREFIX / 'gobbonet-launch')

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
            route = urllib.parse.urlsplit(self.path)
            if route.path == '/api/scan':
                # The Install location step asks what a typed folder holds, so
                # someone pointing it at a model collection sees it was found.
                # Counts only -- never names -- and only on the PC (Host check).
                raw = urllib.parse.parse_qs(route.query).get('path', [''])[0]
                folder = Path(raw).expanduser() if raw.strip() else None
                if folder is None or not folder.is_absolute():
                    self.reply(200, {'absolute': False, 'exists': False, 'models': 0, 'models_sub': 0})
                    return
                top, sub = count_models(folder) if folder.is_dir() else (0, 0)
                self.reply(200, {'absolute': True, 'exists': folder.is_dir(),
                                 'models': top, 'models_sub': sub})
            elif self.path == '/api/extras':
                self.reply(200, extra)
            elif self.path == '/api/state':
                code, state = proxy(self.path)
                state.update(data_dir=get('data_dir'), listen_port=int(get('listen_port')),
                             model_dir=get('model_dir'))
                state['models_found'], state['models_sub'] = count_models(Path(state['model_dir']))
                self.reply(code, state)
            elif self.path in ('/api/download', '/api/gpu'):
                self.reply(*proxy(self.path))
            else:
                self.reply(404, {'error': 'Not found'})
        except Exception as e:
            self.reply(500, {'error': str(e)})

    def do_POST(self):
        global mode, extra, added_dirs
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
                    # Two folders since 1.8.0 (issue #68): data (chats, config
                    # state, downloads) and models. model_dir is stored exactly
                    # as chosen -- it used to be <folder>/models whatever was
                    # chosen, so pointing setup at a model collection gave an
                    # empty subfolder. {path} alone is the old one-folder form.
                    data_raw = req.get('data', req.get('path')) or ''
                    models_raw = req.get('models') or ''
                    data = Path(data_raw).expanduser()
                    if not data_raw.strip() or not data.is_absolute():
                        raise ValueError('Choose an absolute path for the data folder, like /home/you/GobboNet.')
                    models = Path(models_raw).expanduser() if models_raw.strip() else data / 'models'
                    if not models.is_absolute():
                        raise ValueError('Choose an absolute path for the models folder, like /home/you/models.')
                    if data != Path(get('data_dir')) and (Path(get('data_dir')) / 'setup-complete.json').exists():
                        raise ValueError('Existing installation: keep this folder to preserve your data. Move it separately before changing it.')
                    writable(data, 'data')
                    # Downloads land in the models folder, so it is write-tested
                    # too. Nothing already in it is touched.
                    writable(models, 'models')
                    top, sub = count_models(models)
                    put('data_dir', data)
                    put('model_dir', models)
                    # The model menu lists the top of the models folder. Models
                    # one folder down (a collection sorted by maker) are offered
                    # under Add a Model > Found on this computer, which reads
                    # model_dirs, and are linked into the models folder from there.
                    before = get_list('model_dirs')
                    dirs = [d for d in before if d not in added_dirs]
                    added_dirs = []
                    if sub and str(models) not in dirs:
                        dirs.append(str(models))
                        added_dirs = [str(models)]
                    if dirs != before:
                        put_list('model_dirs', dirs)
                    start()
                    self.reply(200, {'ok': True, 'model_dir': str(models),
                                     'models_found': top, 'models_in_subfolders': sub})
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
                            folder = Path(get('model_dir'))
                            valid = any(is_gguf(m) for m in model_files(folder))
                            # A collection one folder down is enough when setup
                            # put it in model_dirs: the chat opens with it under
                            # Add a Model > Found on this computer.
                            if not valid and str(folder) in get_list('model_dirs'):
                                try:
                                    subs = [e.path for e in os.scandir(folder)
                                            if e.is_dir() and not e.name.startswith('.')][:SUB_CAP]
                                except OSError:
                                    subs = []
                                valid = any(is_gguf(m) for d in subs for m in model_files(d))
                            if not valid:
                                raise ValueError('Download a model, or put your GGUF in ' + str(folder))
                    result = proxy(self.path, body)
                    if self.path == '/api/backend' and result[0] == 200:
                        mode = req['mode']
                    if self.path == '/api/finish' and result[0] == 200 and req.get('autostart'):
                        desktop = Path(os.environ.get('XDG_CONFIG_HOME', str(Path.home() / '.config'))) / 'autostart/gobbonet.desktop'
                        launcher = login_program()
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
