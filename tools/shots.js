'use strict';
/*
 * README pictures of the Hostwerk app: a throwaway Hostwerk (temporary folder, never the real ~/Hostwerk) with this
 * extension, remote access switched on (password + two-factor code), two paired phones and a fresh pairing code.
 *   docs/screenshot.png / .de.png   Go live → Hostwerk app (PC)
 *   docs/phone.png / .de.png        the phone screen #/handy (390 × 844)
 * The address of this PC's network is replaced before every picture.
 *   node tools/shots.js            (needs ../hostwerk with a built ui/dist and puppeteer-core + Chrome/Edge)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');

const DIR = path.join(__dirname, '..');
const HOSTWERK = process.env.HOSTWERK_DIR || path.join(DIR, '..', '..', 'hostwerk');
const { startServer } = require(path.join(HOSTWERK, 'scripts', 'lib', 'ui-server'));
const { totp } = require(path.join(HOSTWERK, 'server', 'services', 'live', 'remote'));
const puppeteer = require(require.resolve('puppeteer-core', { paths: [HOSTWERK, DIR] }));
const EXE = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/chromium'].filter(Boolean).find((p) => fs.existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lan = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal && !/^169\.254\./.test(a.address));

(async () => {
  if (!lan) throw new Error('No network address – remote access needs one.');
  const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-pwa-shots-'));
  fs.cpSync(DIR, path.join(ext, 'hostwerk-ext-pwa'), { recursive: true, filter: (f) => !/[\\/](\.git|node_modules|docs)([\\/]|$)/.test(f) });
  const port = 21000 + Math.floor(Math.random() * 9000);
  const srv = await startServer({ port, ext, clicktest: false });
  const api = async (method, p, body) => { const r = await fetch(`${srv.origin}/api${p}`, { method, headers: { 'x-hostwerk-token': srv.token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${await r.text()}`); return r.json(); };
  const phone = (p, body, ua) => new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const rq = https.request({ host: lan.address, port: port + 1, path: p, method: 'POST', rejectUnauthorized: false, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), 'user-agent': ua } }, (res) => { res.resume(); res.on('end', resolve); });
    rq.on('error', reject); rq.end(data);
  });
  const browser = await puppeteer.launch({ executablePath: EXE, headless: true });
  try {
    await api('PUT', '/live/remote', { password: 'Screenshot-Passwort-2026', port: port + 1, user: 'pascal' });
    const q = await api('POST', '/live/remote/totp/new');
    await api('POST', '/live/remote/totp/confirm', { code: totp(q.secret) });
    await api('PUT', '/live/remote', { enabled: true });
    await sleep(1500);
    for (const [name, ua] of [['Pixel 8', 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36'], ['iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1']]) {
      const c = await api('POST', '/pwa/pair', {});
      await phone('/api/x/pwa/pub/pair', { code: c.url.split('#')[1], name }, ua);
    }
    // Hide this PC's address in everything that is shown
    const mask = (page) => page.evaluate((ip) => {
      const walk = (n) => { if (n.nodeType === 3) n.nodeValue = n.nodeValue.split(ip).join('192.168.178.20'); else n.childNodes.forEach(walk); };
      walk(document.body);
    }, lan.address);
    for (const lang of ['en', 'de']) {
      await api('PUT', '/settings/general', { language: lang });
      const suffix = lang === 'de' ? '.de' : '';
      const p = await browser.newPage();
      await p.setViewport({ width: 1440, height: 1000 });
      await p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
      await p.goto(`${srv.origin}/?token=${srv.token}#/live/app`, { waitUntil: 'networkidle2' });
      await sleep(2500);
      await p.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => /Create pairing code|Kopplungs-Code erstellen/.test(x.textContent)); if (b) b.click(); });
      await sleep(1500);
      await mask(p);
      await p.screenshot({ path: path.join(DIR, 'docs', `screenshot${suffix}.png`) });
      const m = await browser.newPage();
      await m.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      await m.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
      await m.goto(`${srv.origin}/?token=${srv.token}#/handy`, { waitUntil: 'networkidle2' });
      await sleep(2500);
      await mask(m);
      await m.screenshot({ path: path.join(DIR, 'docs', `phone${suffix}.png`) });
      await p.close(); await m.close();
      console.log(`✓ ${lang}`);
    }
  } finally {
    await browser.close();
    await srv.stop();
    fs.rmSync(ext, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exit(1); });
