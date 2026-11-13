"""Optional Docker smoke test. Build dama-verify-{python,rust,typescript} images first."""
import json
import subprocess
import time
import urllib.error
import urllib.request
import uuid

PROJECT = '00000000-0000-4000-8000-000000000001'
CASES = [('python', 'api', 'python-api'), ('rust', 'tools', 'rust-api'), ('typescript', '', 'typescript-api')]
containers = []
ports = []


def docker(*args):
    return subprocess.check_output(['docker', *args], text=True).strip()


def get(port, path):
    with urllib.request.urlopen(f'http://127.0.0.1:{port}{path}', timeout=2) as response:
        return response.status, json.load(response)


try:
    # Keep all three running at once on the same internal port to test isolation.
    for language, segment, expected in CASES:
        name = 'dama-smoke-' + uuid.uuid4().hex[:12]
        base = '/' + PROJECT + ('/' + segment if segment else '')
        docker('run', '-d', '--name', name, '--label', 'team.objlabs.dama.smoke=true',
               '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
               '--memory', '128m', '--cpus', '1', '--pids-limit', '64',
               '-p', '127.0.0.1::3000', '-e', 'PORT=3000', '-e', 'DAMA_BASE_PATH=' + base,
               'dama-verify-' + language)
        containers.append(name)
        mapped = json.loads(docker('inspect', '--format', '{{json .NetworkSettings.Ports}}', name))['3000/tcp']
        assert len(mapped) == 1 and mapped[0]['HostIp'] == '127.0.0.1', mapped
        port = int(mapped[0]['HostPort'])
        assert port not in ports, 'Host port collision'
        ports.append(port)
        deadline = time.monotonic() + 15
        while True:
            try:
                status, body = get(port, base + '/health')
                assert status == 200 and body == {'service': expected, 'ok': True}, body
                break
            except (OSError, urllib.error.URLError):
                if time.monotonic() >= deadline:
                    raise RuntimeError(language + ' failed to become healthy: ' + docker('logs', name))
                time.sleep(0.2)
        assert get(port, base + '/')[0] == 200
        try:
            get(port, '/health')
            raise AssertionError('Unprefixed health endpoint unexpectedly exposed')
        except urllib.error.HTTPError as error:
            assert error.code == 404
        print(f'{language}: UUID health/home OK, root rejected; internal 3000 -> loopback {port}', flush=True)
    print('All three languages run concurrently without port collisions.', flush=True)
finally:
    for name in containers:
        subprocess.run(['docker', 'rm', '-f', name], check=False, stdout=subprocess.DEVNULL)
