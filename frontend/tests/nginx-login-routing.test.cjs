// Optional actual nginx contract: cached images only, no host ports or external network.
// Run in a source-only copy with MONSHINMATE_NGINX_TEST_IMAGE=<cached-image-id>.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const image = process.env.MONSHINMATE_NGINX_TEST_IMAGE;
test('real nginx serves login navigation and preserves backend authentication methods', { skip: !image }, () => {
  assert.match(image, /^sha256:[a-f0-9]{64}$/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monshinmate-nginx-synthetic-'));
  fs.chmodSync(dir, 0o755);
  fs.mkdirSync(path.join(dir, 'html'), { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'html/index.html'), '<!doctype html><title>SYNTHETIC_SPA_ONLY</title>', { mode: 0o644 });
  // The operator shell may use umask 077; nginx workers must read this synthetic root.
  fs.chmodSync(path.join(dir, 'html'), 0o755);
  fs.chmodSync(path.join(dir, 'html/index.html'), 0o644);
  let template = fs.readFileSync(path.resolve(__dirname, '../nginx.conf.template'), 'utf8');
  template = template.replaceAll('${NGINX_LISTEN_PORT}', '18080')
    .replaceAll('${BACKEND_ORIGIN}', 'http://127.0.0.1:18081')
    .replaceAll('${BACKEND_HOST_HEADER}', 'synthetic-backend.invalid')
    .replace('root /usr/share/nginx/html;', 'root /fixture/html;');
  fs.writeFileSync(path.join(dir, 'nginx.conf'), `
worker_processes 1;
pid /tmp/nginx.pid;
error_log /dev/stderr warn;
events { worker_connections 64; }
http {
  include /etc/nginx/mime.types;
  access_log off;
  client_body_temp_path /tmp/client;
  proxy_temp_path /tmp/proxy;
  fastcgi_temp_path /tmp/fastcgi;
  uwsgi_temp_path /tmp/uwsgi;
  scgi_temp_path /tmp/scgi;
  server { listen 18081; location / { return 401 'SYNTHETIC_BACKEND:$request_method:$uri'; } }
  ${template}
}
`, { mode: 0o644 });
  const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
  const common = ['--pull=never', '--network=none', '--read-only', '--tmpfs', '/tmp',
    '--mount', `type=bind,source=${dir},target=/fixture,readonly`, '--entrypoint=nginx'];
  docker(['run', '--rm', ...common, image, '-c', '/fixture/nginx.conf', '-t']);
  let id;
  try {
    id = docker(['run', '--rm', '-d', ...common, image, '-c', '/fixture/nginx.conf', '-g', 'daemon off;']).trim();
    assert.match(id, /^[a-f0-9]{64}$/);
    const request = (method, route) => docker(['run', '--rm', '--pull=never', `--network=container:${id}`,
      '--read-only', '--entrypoint=curl', 'curlimages/curl:8.12.1', '--silent', '--show-error',
      '--retry', '3', '--retry-connrefused', '--max-time', '5', '--include',
      ...(method === 'HEAD' ? ['--head'] : ['--request', method]), `http://127.0.0.1:18080${route}`]);
    for (const route of ['/admin/login', '/admin/login?synthetic=1']) {
      const response = request('GET', route);
      assert.match(response, /^HTTP\/1\.1 200 /);
      assert.match(response, /SYNTHETIC_SPA_ONLY/);
      assert.doesNotMatch(response, /SYNTHETIC_BACKEND/);
      assert.match(response, /Cache-Control: no-store/i);
      assert.match(response, /X-Frame-Options: DENY/i);
      assert.match(response, /X-Content-Type-Options: nosniff/i);
      assert.match(response, /Content-Type: text\/html/i);
    }
    const head = request('HEAD', '/admin/login');
    assert.match(head, /^HTTP\/1\.1 200 /);
    assert.match(head, /Cache-Control: no-store/i);
    assert.doesNotMatch(head, /SYNTHETIC_SPA_ONLY|SYNTHETIC_BACKEND/);
    for (const [method, route] of [['POST', '/admin/login'], ['OPTIONS', '/admin/login'],
      ['POST', '/admin/login/totp'], ['GET', '/admin/login/totp']]) {
      const response = request(method, route);
      assert.match(response, /^HTTP\/1\.1 401 /);
      assert.ok(response.includes(`SYNTHETIC_BACKEND:${method}:${route}`));
      assert.doesNotMatch(response, /SYNTHETIC_SPA_ONLY/);
      assert.match(response, /Cache-Control: no-store/i);
      assert.match(response, /X-Frame-Options: DENY/i);
    }
  } finally {
    if (id && /^[a-f0-9]{64}$/.test(id)) docker(['stop', '--time=2', id]);
    // Keep only synthetic fixtures for diagnosis; no original files are removed.
  }
});
