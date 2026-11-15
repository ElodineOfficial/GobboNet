import os, pathlib, subprocess, tempfile, time, json, urllib.request, urllib.error, socket, signal
ROOT=pathlib.Path(__file__).resolve().parents[1]; PREFIX=pathlib.Path(os.environ.get('GOBBONET_TEST_PREFIX', str(ROOT/'linux-amd64')))
# What a user runs. The packages' launcher by default; point GOBBONET_TEST_ENTRY
# at an extracted ZIP's top-level ./gobbonet to run the same first run through
# the ZIP's front door (roadmap 1.7.7 #14).
ENTRY=os.environ.get('GOBBONET_TEST_ENTRY', str(PREFIX/'gobbonet-launch'))
http=urllib.request.build_opener(urllib.request.ProxyHandler({}))
def freeport():
    with socket.socket() as s: s.bind(('127.0.0.1',0)); return s.getsockname()[1]
def time_wait_port():
    # What a GobboNet closed with a tab open leaves: its end of each connection
    # in TIME_WAIT on its port for about a minute (tests/test-setup-port.py).
    srv=socket.socket();srv.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);srv.bind(('127.0.0.1',0));srv.listen();port=srv.getsockname()[1]
    tab=socket.create_connection(('127.0.0.1',port));conn,_=srv.accept();srv.close();conn.close();time.sleep(.05);tab.close();time.sleep(.1)
    return port
def test(lan):
    with tempfile.TemporaryDirectory(dir=ROOT) as t:
        d=pathlib.Path(t); env=os.environ.copy();env.update(XDG_CONFIG_HOME=str(d/'config'),XDG_DATA_HOME=str(d/'data'),DISPLAY=':99')
        fake=d/'bin';fake.mkdir(); browser=d/'browser.log'
        (fake/'xdg-open').write_text('#!/bin/sh\nprintf "%s\\n" "$1" >> "$BROWSER_LOG"\n');(fake/'xdg-open').chmod(0o755)
        env.update(PATH=str(fake)+':'+env['PATH'],BROWSER_LOG=str(browser))
        p=subprocess.Popen([ENTRY],env=env,start_new_session=True)
        try:
            for _ in range(100):
                if browser.exists(): break
                if p.poll() is not None: raise AssertionError('launcher stopped')
                time.sleep(.1)
            url=browser.read_text().splitlines()[0]
            def get(path): return json.load(http.open(url+path))
            def post(path,data,code=200):
                r=urllib.request.Request(url+path,data=json.dumps(data).encode(),headers={'Content-Type':'application/json','Origin':url.rstrip('/')})
                try: res=http.open(r)
                except urllib.error.HTTPError as e: res=e
                body=json.load(res);assert res.code==code,(path,res.code,body);return body
            state=get('api/state');assert state['has_engine'],state
            post('api/location',{'path':str(d/'chosen folder')})
            post('api/password',{'password':'test-only-password','confirm':'test-only-password'})
            post('api/port',{'port':11437},400)
            # Setup run again just after closing GobboNet: its port, still in
            # TIME_WAIT, is one GobboNet can listen on, so it is accepted. A port
            # something is listening on is refused, in words.
            post('api/port',{'port':time_wait_port()})
            with socket.socket() as taken:
                taken.bind(('127.0.0.1',0));taken.listen()
                body=post('api/port',{'port':taken.getsockname()[1]},400);assert 'already in use' in body['error'],body
            port=freeport();post('api/port',{'port':port})
            post('api/backend',{'mode':'local'})
            post('api/finish',{'lan':lan},400)
            post('api/backend',{'mode':'remote','url':'http://127.0.0.1:1','key':''})
            post('api/finish',{'lan':lan,'autostart':False})
            for _ in range(150):
                if len(browser.read_text().splitlines())>=2:break
                if p.poll() is not None:raise AssertionError((d/'data/gobbonet/launch.log').read_text())
                time.sleep(.1)
            urls=browser.read_text().splitlines();assert urls[-1]==f'http://127.0.0.1:{port}/',urls
            response=http.open(urls[-1]+'login');assert response.status==200
            cfg=(d/'config/gobbonet/config.toml').read_text();assert ('0.0.0.0' if lan else '127.0.0.1') in cfg
            # A second launch reuses the running server and opens chat, no wizard.
            repeat=subprocess.run([ENTRY],env=env,timeout=15)
            assert repeat.returncode==0
            assert browser.read_text().splitlines()[-1]==urls[-1]
            assert (d/'chosen folder/setup-complete.json').exists()
            print('PASS: first run, location with spaces, password, port rejection/custom port, port just closed vs taken, missing-model guard, remote switch, '+('LAN' if lan else 'local')+', auto-open, repeat launch',flush=True)
        finally:
            # The launcher may already be gone -- that is usually WHY we are in
            # here. killpg on a group with nothing left in it raises
            # ProcessLookupError, which used to replace the real failure as the
            # error the run reported.
            try: os.killpg(p.pid,signal.SIGTERM)
            except ProcessLookupError: pass
            p.wait(timeout=15)
for lan in (False,True):test(lan)
