// Exercises alexa-cookie 5.0.6 (as embedded in echo-speaks-server) end to end against a fake Amazon:
// proxy login -> device registration -> local cookies + csrf, then a cookie refresh called the way
// index.js /refreshCookie calls it.
'use strict';
const path = require('path');
const http = require('http');
const https = require('https');
const assert = require('assert');

const repo = process.argv[2] || path.join(__dirname, '..');
const express = require(path.join(repo, 'node_modules', 'express'));

const seen = [];
const fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
        const host = req.headers['x-fake-host'];
        seen.push({ host, method: req.method, url: req.url, body, headers: req.headers });
        const key = `${req.method} ${host}${req.url.split('?')[0]}`;
        const json = (code, obj, headers = {}) => { res.writeHead(code, Object.assign({ 'content-type': 'application/json' }, headers)); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
        switch (key) {
            case 'GET www.amazon.com/ap/signin':
                res.writeHead(302, { location: 'https://www.amazon.com/ap/maplanding?openid.oa2.authorization_code=AUTHCODE', 'set-cookie': ['session-id=SID; Domain=.amazon.com; Path=/; Secure'] });
                return res.end();
            case 'POST api.amazon.com/auth/register':
                return json(200, { response: { success: { tokens: {
                    bearer: { access_token: 'ACCESS1', refresh_token: 'REFRESH1' },
                    mac_dms: { device_private_key: 'k' },
                    website_cookies: [{ Name: 'at-main', Value: 'AT1' }, { Name: 'sess-at-main', Value: 'SAT1' }],
                } } } });
            case 'PUT api.amazonalexa.com/v1/devices/@self/capabilities':
                return json(204);
            case 'GET alexa.amazon.com/api/users/me':
                return json(200, { marketPlaceDomainName: 'www.amazon.com' });
            case 'POST www.amazon.com/ap/exchangetoken/cookies':
                return json(200, { response: { tokens: { cookies: { '.amazon.com': [{ Name: 'at-main', Value: 'ATX' }, { Name: 'session-id', Value: 'SIDX' }, { Name: 'ubid-main', Value: 'UB' }] } } } });
            case 'GET alexa.amazon.com/api/language':
                res.writeHead(200, { 'set-cookie': ['csrf=CSRF123; Path=/'] });
                return res.end('{}');
            case 'POST api.amazon.com/auth/token':
                return json(200, { access_token: 'ACCESS2', token_type: 'bearer', expires_in: 3600 });
            default:
                return json(404, { error: `unmocked ${key}` });
        }
    });
});

const realHttpsRequest = https.request;
let fakePort;
https.request = function (opts, cb) {
    const amazonHost = opts.host || opts.hostname;
    const headers = Object.assign({}, opts.headers, { 'x-fake-host': amazonHost });
    const o = Object.assign({}, opts, { protocol: 'http:', host: '127.0.0.1', hostname: '127.0.0.1', port: fakePort, agent: false, headers });
    delete o.servername;
    const r = http.request(o, cb);
    r.on('socket', s => { s._host = amazonHost; });
    return r;
};

function get(port, p, headers = {}) {
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: p, headers: Object.assign({ host: `127.0.0.1:${port}` }, headers) }, res => {
            let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
        }).on('error', reject);
    });
}

(async () => {
    await new Promise(r => fake.listen(0, '127.0.0.1', r));
    fakePort = fake.address().port;
    let pass = 0;
    const ok = (cond, msg) => { assert.ok(cond, msg); pass++; console.log('  ok -', msg); };

    const alexaCookie = require(path.join(repo, 'libs/alexa-cookie/alexa-cookie.js'));
    const app = express();
    app.get('/cookie-success', (q, s) => s.send('done'));
    const PORT = 18092;
    const server = await new Promise(r => { const s = app.listen(PORT, '127.0.0.1', () => r(s)); });

    // Same option set index.js startWebServer() builds (non-Heroku, US)
    const opts = {
        checkForCookie: false, serverPort: PORT, amazonPage: undefined, baseAmazonPage: undefined, setupProxy: true,
        proxyOwnIp: '127.0.0.1', proxyListenBind: '0.0.0.0', protocolPrefix: 'http', deviceAppName: 'Echo Speaks',
        amazonPageProxyLanguage: 'en_US', useHeroku: false, proxyHost: '127.0.0.1', proxyPort: PORT, proxyRootPath: '/proxy',
        acceptLanguage: 'en-US', formerRegistrationData: undefined, expressInstance: app, formerDataStorePath: '/tmp/es-fds-test2.json',
    };

    // ---- Login + registration -------------------------------------------------------------
    const results = [];
    const done = new Promise(resolve => {
        alexaCookie.generateAlexaCookie(undefined, undefined, opts, (err, result) => {
            results.push({ err, result });
            if (result) resolve(result);
        });
    });
    await new Promise(r => setTimeout(r, 200));
    ok(results[0] && results[0].err && /Please open http:\/\/127\.0\.0\.1:18092\/ /.test(results[0].err.message), `first callback asks user to open login URL (${results[0] && results[0].err.message.slice(0, 60)})`);

    const r = await get(PORT, '/proxy/www.amazon.com/ap/signin?x=1');
    ok(r.status === 302 && r.headers.location === `http://127.0.0.1:${PORT}/cookie-success`, 'sign-in success redirects browser to /cookie-success');
    const reg = await done;

    const regReq = seen.find(s => s.url === '/auth/register');
    const regBody = JSON.parse(regReq.body);
    ok(regBody.auth_data.authorization_code === 'AUTHCODE' && regBody.auth_data.code_verifier && regBody.auth_data.client_domain === 'DeviceLegacy', 'registration uses authorization code + PKCE verifier');
    ok(regBody.registration_data.app_name === 'Echo Speaks', `registered app_name = ${regBody.registration_data.app_name}`);
    ok(reg.csrf === 'CSRF123', `result.csrf = ${reg.csrf}`);
    ok(/at-main=ATX/.test(reg.localCookie) && /csrf=CSRF123/.test(reg.localCookie), 'result.localCookie has exchanged cookies + csrf');
    ok(reg.refreshToken === 'REFRESH1' && reg.loginCookie && reg.amazonPage === 'amazon.com', 'result has refreshToken, loginCookie, amazonPage');
    // index.js success test: result && result.csrf && (result.cookie || result.localCookie)
    ok(!!(reg && reg.csrf && (reg.cookie || reg.localCookie)), 'index.js success condition is satisfied');
    // index.js isCookieValid() requires loginCookie + csrf
    ok(!!(reg.loginCookie && reg.csrf), 'isCookieValid() inputs present (loginCookie + csrf)');

    alexaCookie.stopProxyServer();
    const after = await get(PORT, '/proxy');
    ok(after.status === 404, 'stopProxyServer() unmounts /proxy from the server app');

    // ---- Refresh, exactly as index.js /refreshCookie calls it ---------------------------
    seen.length = 0;
    const former = JSON.parse(JSON.stringify(reg));
    const refreshed = await new Promise(resolve => alexaCookie.refreshAlexaCookie({
        formerRegistrationData: former, deviceAppName: 'Echo Speaks', acceptLanguage: 'en-US', logger: undefined,
    }, (err, result) => resolve({ err, result })));
    ok(!refreshed.err, `refresh succeeded (${refreshed.err && refreshed.err.message})`);
    ok(!seen.some(s => s.url === '/auth/register'), 'refresh does NOT re-register the device (the 3.4.1 behaviour)');
    const tokenReq = seen.find(s => s.url === '/auth/token');
    ok(tokenReq && /app_name=Echo%20Speaks/.test(tokenReq.body) && /source_token=REFRESH1/.test(tokenReq.body), 'token refresh uses app_name=Echo Speaks + stored refresh token');
    ok(refreshed.result.accessToken === 'ACCESS2' && refreshed.result.csrf === 'CSRF123' && /at-main=ATX/.test(refreshed.result.localCookie), 'refreshed result has new access token, csrf, local cookie');
    ok(/frc=/.test(refreshed.result.loginCookie) && /map-md=/.test(refreshed.result.loginCookie), 'frc + map-md preserved in loginCookie');
    ok(refreshed.result.refreshToken === 'REFRESH1' && refreshed.result.deviceSerial === reg.deviceSerial, 'refresh token + device serial kept');

    // Old 3.4.1-era cookieData (what the hub already holds) must also refresh
    seen.length = 0;
    const legacy = { loginCookie: 'frc=F; map-md=M; session-id=1; at-main=OLD', refreshToken: 'REFRESH1', amazonPage: 'amazon.com', localCookie: 'x=1', csrf: 'OLDCSRF', deviceSerial: 'abc', deviceId: 'def', frc: 'F', 'map-md': 'M', accessToken: 'OLD' };
    const legacyRefresh = await new Promise(resolve => alexaCookie.refreshAlexaCookie({ formerRegistrationData: legacy, deviceAppName: 'Echo Speaks' }, (err, result) => resolve({ err, result })));
    ok(!legacyRefresh.err && legacyRefresh.result.csrf === 'CSRF123', 'existing 3.4.1-format cookie data from the hub refreshes too');

    console.log(`\n${pass} checks passed`);
    server.close(); fake.close(); https.request = realHttpsRequest;
    process.exit(0);
})().catch(e => { console.error('FAIL:', e.stack); process.exit(1); });
