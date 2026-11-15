// Exercises the ported alexa-cookie 5.0.6 proxy mounted inside an Express app under /proxy,
// the way echo-speaks-server uses it. Outbound HTTPS to Amazon is redirected to a local fake.
'use strict';
const path = require('path');
const http = require('http');
const https = require('https');
const assert = require('assert');

const repo = process.argv[2] || path.join(__dirname, '..');
const express = require(path.join(repo, 'node_modules', 'express'));

// ---- fake Amazon -------------------------------------------------------------------------
const seen = [];
let fakeHandler = null;
const fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
        seen.push({ host: req.headers.host, method: req.method, url: req.url, body, headers: req.headers });
        fakeHandler(req, res, body);
    });
});

const realHttpsRequest = https.request;
let fakePort;
https.request = function (opts, cb) {
    // http-proxy passes an options object; keep path/method/headers, retarget to fake.
    const o = Object.assign({}, opts, { protocol: 'http:', host: '127.0.0.1', hostname: '127.0.0.1', port: fakePort, agent: false });
    delete o.servername;
    const amazonHost = opts.host || opts.hostname;
    const r = http.request(o, cb);
    r.on('socket', s => { s._host = amazonHost; }); // library reads the upstream host from socket._host
    return r;
};

function req(port, method, p, headers = {}, body) {
    return new Promise((resolve, reject) => {
        const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: Object.assign({ host: `127.0.0.1:${port}` }, headers) }, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
        });
        r.on('error', reject);
        if (body) r.write(body);
        r.end();
    });
}

(async () => {
    await new Promise(r => fake.listen(0, '127.0.0.1', r));
    fakePort = fake.address().port;

    const { initAmazonProxy } = require(path.join(repo, 'libs/alexa-cookie/lib/proxy.js'));
    const app = express();
    app.get('/cookie-success', (q, s) => s.send('server-success-page'));
    const PORT = 18091;
    let captured = null;
    const logs = [];
    initAmazonProxy({
        proxyRootPath: '/proxy', protocolPrefix: 'http', proxyOwnIp: '127.0.0.1', proxyHost: '127.0.0.1', proxyPort: PORT,
        baseAmazonPage: 'amazon.com', baseAmazonPageHandle: '', amazonPageProxyLanguage: 'en_US', acceptLanguage: 'en-US',
        expressInstance: app, formerDataStorePath: '/tmp/es-fds-test.json', proxyLogLevel: 'warn', logger: m => logs.push(String(m)),
    }, (err, data) => { captured = data; }, () => {});
    const server = await new Promise(r => { const s = app.listen(PORT, '127.0.0.1', () => r(s)); });

    let pass = 0;
    const ok = (cond, msg) => { assert.ok(cond, msg); pass++; console.log('  ok -', msg); };

    // 1. Initial login request goes to Amazon sign-in with code+PKCE flow
    fakeHandler = (q, s) => { s.writeHead(200, { 'content-type': 'text/html' }); s.end('<html>signin</html>'); };
    seen.length = 0;
    let r = await req(PORT, 'GET', '/proxy');
    ok(r.status === 200, 'GET /proxy is proxied (200 from fake Amazon)');
    ok(seen[0] && seen[0].url.startsWith('/ap/signin?') && seen[0].host === 'www.amazon.com', `initial request -> www.amazon.com/ap/signin (got ${seen[0] && seen[0].host}${seen[0] && seen[0].url.slice(0, 20)})`);
    ok(/openid\.oa2\.response_type=code/.test(seen[0].url) && /code_challenge_method=S256/.test(seen[0].url), 'uses authorization-code + PKCE flow');

    // 2. Prefixed path maps to host + path
    seen.length = 0;
    r = await req(PORT, 'GET', '/proxy/www.amazon.com/ap/signin?x=1');
    ok(seen[0].host === 'www.amazon.com' && seen[0].url === '/ap/signin?x=1', 'GET /proxy/www.amazon.com/ap/signin?x=1 -> www.amazon.com/ap/signin?x=1');

    // 3. Escaped root-relative /ax/claim POST is bounced back into the proxy and body survives
    r = await req(PORT, 'POST', '/ax/claim?arb=1', { 'content-type': 'application/x-www-form-urlencoded' }, 'email=a%40b.c');
    ok(r.status === 307 && r.headers.location === '/proxy/www.amazon.com/ax/claim?arb=1', `POST /ax/claim -> 307 ${r.headers.location}`);
    seen.length = 0;
    r = await req(PORT, 'POST', r.headers.location, { 'content-type': 'application/x-www-form-urlencoded', referer: `http://127.0.0.1:${PORT}/proxy/www.amazon.com/ap/signin` }, 'email=a%40b.c');
    ok(seen[0].host === 'www.amazon.com' && seen[0].url === '/ax/claim?arb=1' && seen[0].method === 'POST', 'POST reaches www.amazon.com/ax/claim');
    ok(seen[0].body === 'email=a%40b.c', `POST body forwarded intact (${seen[0].body})`);
    ok(seen[0].headers.referer === 'https://www.amazon.com/ap/signin', `Referer rewritten back to Amazon (${seen[0].headers.referer})`);

    // 4. CSP / HSTS stripped, body URLs rewritten, meta upgrade-insecure-requests removed
    fakeHandler = (q, s) => {
        s.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': 'upgrade-insecure-requests', 'strict-transport-security': 'max-age=1' });
        s.end('<meta http-equiv="Content-Security-Policy" content="upgrade-insecure-requests"><form action="https://www.amazon.com/ax/claim"></form>');
    };
    r = await req(PORT, 'GET', '/proxy/www.amazon.com/ap/signin');
    ok(!r.headers['content-security-policy'] && !r.headers['strict-transport-security'], 'CSP and HSTS headers stripped');
    ok(r.body.includes(`action="http://127.0.0.1:${PORT}/proxy/www.amazon.com/ax/claim"`), 'absolute Amazon URLs in body rewritten to proxy');
    ok(!/upgrade-insecure-requests/i.test(r.body), 'meta upgrade-insecure-requests removed');

    // 5. Redirects: absolute and root-relative Location rewritten into the proxy
    fakeHandler = (q, s) => { s.writeHead(302, { location: '/ap/mfa?x=1' }); s.end(); };
    r = await req(PORT, 'GET', '/proxy/www.amazon.com/ap/signin');
    ok(r.headers.location === `http://127.0.0.1:${PORT}/proxy/www.amazon.com/ap/mfa?x=1`, `relative redirect -> ${r.headers.location}`);
    fakeHandler = (q, s) => { s.writeHead(302, { location: 'https://www.amazon.com/ap/cvf/request?y=2' }); s.end(); };
    r = await req(PORT, 'GET', '/proxy/www.amazon.com/ap/signin');
    ok(r.headers.location === `http://127.0.0.1:${PORT}/proxy/www.amazon.com/ap/cvf/request?y=2`, `absolute redirect -> ${r.headers.location}`);

    // 6. Success: maplanding with authorization code -> /cookie-success on the server + callback data
    fakeHandler = (q, s) => {
        s.writeHead(302, { location: 'https://www.amazon.com/ap/maplanding?openid.oa2.authorization_code=AUTHCODE123', 'set-cookie': ['session-id=111; Domain=.amazon.com; Path=/; Secure', 'junk=1; Path=/'] });
        s.end();
    };
    r = await req(PORT, 'GET', '/proxy/www.amazon.com/ap/signin', { cookie: 'session-id=111; ubid-main=222' });
    ok(r.status === 302 && r.headers.location === `http://127.0.0.1:${PORT}/cookie-success`, `success redirects to server /cookie-success (${r.headers.location})`);
    ok(captured && captured.authorization_code === 'AUTHCODE123' && captured.verifier && captured.deviceId, 'callback receives authorization_code, PKCE verifier, deviceId');
    ok(captured && !/junk=/.test(captured.loginCookie) && /session-id=111/.test(captured.loginCookie), `loginCookie sanitized (${captured && captured.loginCookie.slice(0, 60)}...)`);
    r = await req(PORT, 'GET', '/cookie-success');
    ok(r.body === 'server-success-page', "server's own /cookie-success route still answers");

    // 7. Non-matching Host header (e.g. via a reverse proxy) does not start the Amazon sign-in
    fakeHandler = (q, s) => { s.writeHead(200); s.end('x'); };
    seen.length = 0;
    r = await req(PORT, 'GET', '/proxy', { host: 'echo.example.com' });
    ok(seen[0].host === 'alexa.amazon.com', `wrong Host header falls back to alexa.amazon.com (documented limitation)`);

    // 8. Server routes outside /proxy are untouched
    app.get('/config', (q, s) => s.send('config-page'));
    r = await req(PORT, 'GET', '/config');
    ok(r.body === 'config-page', 'non-proxy server routes untouched');

    console.log(`\n${pass} checks passed`);
    server.close(); fake.close(); https.request = realHttpsRequest;
    process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
