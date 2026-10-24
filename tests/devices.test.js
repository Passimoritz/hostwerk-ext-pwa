'use strict';
/*
 * Paired devices without a running Hostwerk – a small fake host (storage, remote access with lockout, members).
 * Most tests are attacks: guessing, reusing or replaying pairing codes, forged and foreign device keys, requests started
 * by other websites, blocked/expired/removed accounts, changed passwords, flooding with devices waiting for approval.
 */
const test = require('node:test');
const assert = require('node:assert');
const { Devices, deviceLabel } = require('../server/devices');

const UA_PHONE = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36';

function fakeHost({ now } = {}) {
  const store = {};
  const fails = [];
  const dropped = [];
  const alerts = [];
  const audits = [];
  const remote = {
    cfg: { enabled: true, user: 'admin', passHash: 'scrypt:owner:1' },
    locked: (ip) => fails.filter((x) => x === ip).length >= 5,
    fail: (ip) => fails.push(ip),
    dropSessions: (pred) => { dropped.push(pred); return 0; },
  };
  const users = { list: [
    { id: 'm1', name: 'anna', role: 'mitglied', passHash: 'scrypt:anna:1' },
    { id: 'm2', name: 'ben', role: 'mitglied', passHash: 'scrypt:ben:1', enabled: false },
  ] };
  const ctx = {
    remote, users,
    settings: { get: () => ({ general: { language: 'de' } }) },
    monitor: { send: async (title) => { alerts.push(title); } },
    audit: { record: (x) => audits.push(x.action) },
  };
  const host = {
    ctx,
    storage: { get: (k) => (k ? store[k] : store), set: (k, v) => { if (v === undefined) delete store[k]; else store[k] = JSON.parse(JSON.stringify(v)); } },
    error: (status, msg) => Object.assign(new Error(msg), { status }),
    broadcast: () => {},
  };
  const devices = new Devices(host, now ? { now } : {});
  return { devices, host, store, fails, dropped, alerts, audits, remote, users };
}
const req = ({ ip = '203.0.113.7', cookie = '', site, ua = UA_PHONE } = {}) => ({ socket: { remoteAddress: ip }, headers: { cookie, 'user-agent': ua, ...(site ? { 'sec-fetch-site': site } : {}) } });
const keyOf = (setCookie) => setCookie.match(/hw_device=([^;]+)/)[1];
const withKey = (k, extra = {}) => req({ cookie: `hw_device=${k}`, ...extra });

test('pairing: valid code → device key; device is signed in with the owner rights', () => {
  const { devices } = fakeHost();
  const { code } = devices.createCode({});
  const out = devices.pair(req(), { code, name: 'Pixel' });
  const s = devices.verify(withKey(keyOf(out.cookie)));
  assert.strictEqual(s.user, 'admin'); assert.strictEqual(s.role, 'admin'); assert.strictEqual(s.device, out.device.id);
  assert.match(out.cookie, /HttpOnly; Secure; SameSite=Lax/);
});

test('attack: a code works exactly once (replay of a used code fails and counts as a failed sign-in)', () => {
  const { devices, fails } = fakeHost();
  const { code } = devices.createCode({});
  devices.pair(req(), { code });
  assert.throws(() => devices.pair(req({ ip: '198.51.100.9' }), { code }), (e) => e.status === 401);
  assert.deepStrictEqual(fails, ['198.51.100.9']);
});

test('attack: guessing codes – wrong, malformed or huge codes fail; after 5 tries the address is locked even for a valid code', () => {
  const { devices } = fakeHost();
  const ip = '198.51.100.20';
  for (const code of ['A'.repeat(22), 'x', '../../etc', 'B'.repeat(5000)]) assert.throws(() => devices.pair(req({ ip }), { code }), (e) => e.status === 401);
  assert.throws(() => devices.pair(req({ ip }), { code: { $ne: null } }), (e) => e.status === 401);
  const { code } = devices.createCode({});
  assert.throws(() => devices.pair(req({ ip }), { code }), (e) => e.status === 429, 'locked address');
  assert.ok(devices.pair(req({ ip: '198.51.100.21' }), { code }).cookie, 'the valid code was not used up by the locked address');
});

test('attack: an old code (older than 5 minutes) no longer works', () => {
  let t = Date.now();
  const { devices } = fakeHost({ now: () => t });
  const { code } = devices.createCode({});
  t += 5 * 60 * 1000 + 1;
  assert.throws(() => devices.pair(req(), { code }), (e) => e.status === 401);
});

test('attack: remote access switched off → no pairing at all', () => {
  const { devices, remote } = fakeHost();
  const { code } = devices.createCode({});
  remote.cfg.enabled = false;
  assert.throws(() => devices.pair(req(), { code }), (e) => e.status === 403);
});

test('attack: forged keys – right id with a wrong secret, unknown id, broken format: never signed in', () => {
  const { devices } = fakeHost();
  const { code } = devices.createCode({});
  const k = keyOf(devices.pair(req(), { code }).cookie);
  const [id, secret] = k.split('.');
  const flip = secret.slice(0, -1) + (secret.endsWith('A') ? 'B' : 'A');
  for (const c of [`${id}.${flip}`, `aaaaaaaaaaaa.${secret}`, `${id}.${secret}x`, `${id}`, `${id}.`, `${id.toUpperCase()}.${secret}`, 'hw_device']) assert.strictEqual(devices.verify(withKey(c)), null, c);
  assert.strictEqual(devices.verify(req({ cookie: `x_hw_device=${k}` })), null, 'other cookie name');
});

test('attack: requests started by another website (CSRF, cross-site WebSocket) do not get the device key', () => {
  const { devices } = fakeHost();
  const { code } = devices.createCode({});
  const k = keyOf(devices.pair(req(), { code }).cookie);
  assert.strictEqual(devices.verify(withKey(k, { site: 'cross-site' })), null);
  assert.strictEqual(devices.verify(withKey(k, { site: 'same-site' })), null, 'neighbouring subdomain');
  for (const site of ['same-origin', 'none', undefined]) assert.ok(devices.verify(withKey(k, { site })), String(site));
});

test('attack: a member cannot keep a phone signed in without the owner – always waits for approval, even with approval switched off', () => {
  const { devices } = fakeHost();
  devices.setSettings({ approveNew: false });
  const r = devices.remember(req(), { user: 'anna', userId: 'm1', role: 'mitglied' }, {});
  assert.strictEqual(r.device.status, 'pending');
  assert.strictEqual(devices.verify(withKey(keyOf(r.cookie))), null, 'pending = not signed in');
  devices.approve(r.device.id);
  const s = devices.verify(withKey(keyOf(r.cookie)));
  assert.strictEqual(s.user, 'anna'); assert.strictEqual(s.userId, 'm1'); assert.strictEqual(s.role, 'mitglied', 'member rights, never admin');
});

test('owner: with approval switched on (default) the own phone waits too; switched off it is signed in at once', () => {
  const { devices } = fakeHost();
  assert.strictEqual(devices.remember(req(), { user: 'admin' }, {}).device.status, 'pending');
  devices.setSettings({ approveNew: false });
  assert.strictEqual(devices.remember(req(), { user: 'admin' }, {}).device.status, 'active');
});

test('attack: flooding with devices waiting for approval stops at 3 per account', () => {
  const { devices } = fakeHost();
  const s = { user: 'anna', userId: 'm1' };
  for (let i = 0; i < 3; i++) devices.remember(req(), s, {});
  assert.throws(() => devices.remember(req(), s, {}), (e) => e.status === 429);
  assert.ok(devices.remember(req(), { user: 'admin' }, {}), 'other accounts are not affected');
});

test('attack: no sign-in → no "remember"; a device session gets its own device back instead of a new key', () => {
  const { devices } = fakeHost();
  assert.throws(() => devices.remember(req(), null, {}), (e) => e.status === 401);
  const { code } = devices.createCode({});
  const out = devices.pair(req(), { code });
  const s = devices.verify(withKey(keyOf(out.cookie)));
  const again = devices.remember(req(), s, {});
  assert.strictEqual(again.cookie, undefined); assert.strictEqual(again.device.id, out.device.id);
  assert.strictEqual(devices.list.length, 1);
});

test('member switched off, rights ended or removed → the device stops at once (and it never was more than a member)', () => {
  const t = Date.now();
  const { devices, users } = fakeHost({ now: () => t });
  const { code } = devices.createCode({ userId: 'm1' });
  const k = keyOf(devices.pair(req(), { code }).cookie);
  assert.strictEqual(devices.verify(withKey(k)).role, 'mitglied');
  users.list[0].enabled = false; assert.strictEqual(devices.verify(withKey(k)), null);
  users.list[0].enabled = true; users.list[0].until = t - 1; assert.strictEqual(devices.verify(withKey(k)), null);
  delete users.list[0].until; users.list.splice(0, 1); assert.strictEqual(devices.verify(withKey(k)), null);
  assert.throws(() => devices.createCode({ userId: 'm2' }), (e) => e.status === 404, 'no codes for a switched-off member');
});

test('attack: a stolen device key is worthless after a password change (owner and member)', () => {
  const { devices, remote, users } = fakeHost();
  const a = keyOf(devices.pair(req(), { code: devices.createCode({}).code }).cookie);
  const b = keyOf(devices.pair(req(), { code: devices.createCode({ userId: 'm1' }).code }).cookie);
  remote.cfg.passHash = 'scrypt:owner:2';
  users.list[0].passHash = 'scrypt:anna:2';
  assert.strictEqual(devices.verify(withKey(a)), null);
  assert.strictEqual(devices.verify(withKey(b)), null);
});

test('block, block all, sign out: the key stops at once, sessions of the device end, sign-out clears the cookie', () => {
  const { devices, dropped } = fakeHost();
  const k1 = keyOf(devices.pair(req(), { code: devices.createCode({}).code }).cookie);
  const k2 = keyOf(devices.pair(req(), { code: devices.createCode({}).code }).cookie);
  const k3 = keyOf(devices.pair(req(), { code: devices.createCode({}).code }).cookie);
  devices.remove(k1.split('.')[0]);
  assert.strictEqual(devices.verify(withKey(k1)), null); assert.ok(dropped.length >= 1);
  assert.match(devices.logout(withKey(k2)), /hw_device=; .*Max-Age=0/);
  assert.strictEqual(devices.verify(withKey(k2)), null);
  assert.strictEqual(devices.logout(withKey(`${k3.split('.')[0]}.${'A'.repeat(43)}`)), devices.clearCookie(), 'a forged key cannot sign out someone else');
  assert.ok(devices.verify(withKey(k3)), 'the real device is still there');
  assert.strictEqual(devices.removeAll(), 1); assert.strictEqual(devices.verify(withKey(k3)), null);
});

test('unused for longer than the set days → expired and forgotten', () => {
  let t = Date.now();
  const { devices } = fakeHost({ now: () => t });
  devices.setSettings({ idleDays: 7 });
  const k = keyOf(devices.pair(req(), { code: devices.createCode({}).code }).cookie);
  t += 6 * 86400000; assert.ok(devices.verify(withKey(k)), 'used on day 6');
  t += 7 * 86400000 + 1; assert.strictEqual(devices.verify(withKey(k)), null);
  assert.strictEqual(devices.list.length, 0);
  assert.throws(() => devices.setSettings({ idleDays: 0 }), (e) => e.status === 400);
  assert.throws(() => devices.setSettings({ idleDays: 9999 }), (e) => e.status === 400);
});

test('nothing secret is stored: no device secret, no pairing code – only SHA-256 fingerprints', () => {
  const { devices, store } = fakeHost();
  const { code } = devices.createCode({});
  const k = keyOf(devices.pair(req(), { code, name: '<img src=x onerror=alert(1)>Pixel' }).cookie);
  const raw = JSON.stringify(store);
  assert.ok(!raw.includes(k.split('.')[1]), 'secret'); assert.ok(!raw.includes(code), 'code');
  assert.ok(!raw.includes('passHash') && !raw.includes('scrypt:'), 'no password hash');
  assert.ok(!devices.list[0].name.includes('<'), 'name is cleaned');
  assert.ok(!JSON.stringify(devices.view()).includes(devices.list[0].hash), 'the view never shows the fingerprint either');
});

test('limits: at most 5 open codes; alerts and change log for new devices', () => {
  const { devices, alerts, audits } = fakeHost();
  for (let i = 0; i < 5; i++) devices.createCode({});
  assert.throws(() => devices.createCode({}), (e) => e.status === 429);
  const f = fakeHost();
  f.devices.pair(req(), { code: f.devices.createCode({}).code });
  assert.ok(f.alerts.length === 1 && f.audits.length === 1);
  assert.ok(alerts.length === 0 && audits.length === 0);
});

test('device names from the browser', () => {
  assert.strictEqual(deviceLabel(UA_PHONE), 'Android 14 · Chrome');
  assert.strictEqual(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'), 'iPhone · Safari');
});
