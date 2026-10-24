'use strict';
/*
 * Paired devices – the security part of the Hostwerk app.
 *
 * Hostwerk's core keeps the ONE way to sign in (remote access: password + two-factor code, passkeys, members from
 * "Team & roles", lockout per address and per account). This module adds one more kind of credential on top: a device
 * key. Hostwerk asks it on every request without a session (service "devices": verify(req)), so a paired phone stays
 * signed in like an app – with exactly the rights of its account, and only while remote access is on.
 *
 *   Pair with a QR code   PC (admin) creates a one-time code: 128 bits, valid 5 minutes, used once – also when the
 *                         exchange fails afterwards. Wrong codes count as failed sign-ins of that address (core lockout).
 *   Remember this phone   someone signed in normally on the phone (owner or member) keeps the phone signed in.
 *                         With "approve new devices" (default) it waits until the owner approves it on the PC.
 *   Device key            cookie hw_device=<id>.<secret> (HttpOnly, Secure, SameSite=Lax); stored is only SHA-256 of
 *                         the 256-bit secret. Unused for 30 days (adjustable) → expired. Blocking a device works at once.
 *   Account checks        on every request: the owner (main access) or a member that still exists, is enabled and whose
 *                         rights have not ended – the role comes from Team & roles at that moment, never from the device.
 *   Password change       every device remembers a fingerprint of its account's password hash: a new password (owner or
 *                         member) makes all devices of that account invalid at once.
 *   Other websites        the key only counts for requests the browser marks as same-origin or user-started (typed in,
 *                         home screen, QR camera: Sec-Fetch-Site same-origin/none) – never for requests another site or a
 *                         neighbouring subdomain starts (CSRF, cross-site WebSocket).
 *   Members               have no two-factor code of their own – their "remember this phone" ALWAYS waits for approval.
 * Every pairing, approval, block and refused attempt lands in the security log (last 200) and, if it changes
 * something, in Hostwerk's change log; new devices and refused codes also go to the alerts.
 */
const crypto = require('crypto');

const COOKIE = 'hw_device';
const CODE_MS = 5 * 60 * 1000;
const MAX_CODES = 5;
const MAX_PENDING = 3; // per account
const MAX_DEVICES = 50;
const LOG_KEEP = 200;
const SEEN_SAVE_MS = 5 * 60 * 1000;
const DEFAULTS = { approveNew: true, idleDays: 30, alertNew: true };
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const same = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const clean = (s, n = 60) => String(s == null ? '' : s).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);
const ipOf = (req) => String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
/** Short device description from the browser: "Android 14 · Chrome", "iPhone · Safari" … */
function deviceLabel(ua) {
  const u = String(ua || '');
  const os = /iPhone/.test(u) ? 'iPhone' : /iPad/.test(u) ? 'iPad' : /Android ([\d.]+)/.test(u) ? `Android ${u.match(/Android ([\d.]+)/)[1].split('.')[0]}` : /Windows/.test(u) ? 'Windows' : /Mac OS X/.test(u) ? 'Mac' : /Linux/.test(u) ? 'Linux' : 'Device';
  const br = /EdgA?\//.test(u) ? 'Edge' : /SamsungBrowser/.test(u) ? 'Samsung Internet' : /Firefox|FxiOS/.test(u) ? 'Firefox' : /CriOS|Chrome\//.test(u) ? 'Chrome' : /Safari\//.test(u) ? 'Safari' : '';
  return br ? `${os} · ${br}` : os;
}

class Devices {
  /** host: Hostwerk's host object for native extensions (storage, ctx, error, broadcast) */
  constructor(host, { now = () => Date.now() } = {}) {
    this.host = host;
    this.ctx = host.ctx;
    this.now = now;
    this.codes = new Map(); // sha(code) → { userId, name, until, by }
    this.saved = new Map(); // device id → last time lastSeen was written
  }

  /* ---------------- storage ---------------- */
  get settings() { return { ...DEFAULTS, ...(this.host.storage.get('settings') || {}) }; }
  setSettings(b = {}) {
    const s = this.settings;
    if (typeof b.approveNew === 'boolean') s.approveNew = b.approveNew;
    if (typeof b.alertNew === 'boolean') s.alertNew = b.alertNew;
    if (b.idleDays !== undefined) { const d = Math.round(Number(b.idleDays)); if (!(d >= 1 && d <= 365)) throw this.host.error(400, 'Choose between 1 and 365 days.'); s.idleDays = d; }
    this.host.storage.set('settings', s);
    return s;
  }
  get list() { if (!this._list) { const l = this.host.storage.get('devices'); this._list = Array.isArray(l) ? l : []; } return this._list; }
  persist() { this.host.storage.set('devices', this.list); }
  get log() { const l = this.host.storage.get('log'); return Array.isArray(l) ? l : []; }
  note(event, detail = {}) {
    const entry = { t: this.now(), event, ...detail };
    this.host.storage.set('log', [entry, ...this.log].slice(0, LOG_KEEP));
    return entry;
  }
  audit(action, target) { if (this.ctx.audit) try { this.ctx.audit.record({ kind: 'Hostwerk-App', target, action }); } catch { /* egal */ } }
  alert(title, text) {
    if (!this.settings.alertNew || !this.ctx.monitor) return;
    this.ctx.monitor.send(title, text, { kind: 'warn', event: 'security' }).catch(() => {});
  }
  en() { return ((this.ctx.settings.get().general || {}).language) === 'en'; }

  /* ---------------- accounts ---------------- */
  /** Fingerprint of the account's current password hash (owner: remote access, member: Team & roles) – '' if unknown */
  pwStamp(userId) {
    let hash = '';
    if (!userId) hash = (this.ctx.remote && this.ctx.remote.cfg && this.ctx.remote.cfg.passHash) || '';
    else { const list = this.ctx.users && Array.isArray(this.ctx.users.list) ? this.ctx.users.list : []; const u = list.find((x) => x && x.id === userId); hash = (u && u.passHash) || ''; }
    return hash ? sha(`pw:${hash}`).slice(0, 24) : '';
  }
  /** The account a device belongs to – right now: owner, or a member that still may sign in. null = gone/blocked. */
  account(userId) {
    const remote = this.ctx.remote && this.ctx.remote.cfg;
    if (!userId) return remote ? { user: remote.user || 'admin', role: 'admin', userId: undefined } : null;
    const users = this.ctx.users;
    const list = users && Array.isArray(users.list) ? users.list : [];
    const u = list.find((x) => x && x.id === userId);
    if (!u || u.enabled === false || (u.until && Number(u.until) <= this.now())) return null;
    return { user: u.name, role: u.role, userId: u.id };
  }
  /** Who may be chosen when pairing: the owner plus all members (Team & roles). */
  accounts() {
    const remote = this.ctx.remote && this.ctx.remote.cfg;
    const out = [{ id: '', name: remote ? remote.user || 'admin' : 'admin', role: 'admin', owner: true }];
    const list = this.ctx.users && Array.isArray(this.ctx.users.list) ? this.ctx.users.list : [];
    for (const u of list) if (u && u.enabled !== false && !(u.until && Number(u.until) <= this.now())) out.push({ id: u.id, name: u.name, role: u.role });
    return out;
  }

  /* ---------------- the credential (asked by Hostwerk's core) ---------------- */
  /** Device key from the cookie → { id, secret } or null */
  fromCookie(req) {
    const m = String((req && req.headers && req.headers.cookie) || '').match(/(?:^|;\s*)hw_device=([a-f0-9]{12})\.([A-Za-z0-9_-]{43})(?:;|$)/);
    return m ? { id: m[1], secret: m[2] } : null;
  }
  /**
   * Hostwerk's core asks this for every request without a session (remote.session → ctx.devices.verify).
   * Returns the same shape as a sign-in session, or null.
   */
  verify(req) {
    const c = this.fromCookie(req);
    if (!c) return null;
    // Started by another site (link, form, image, WebSocket from elsewhere)? Then the device key does not count.
    const site = String((req.headers && req.headers['sec-fetch-site']) || '').toLowerCase();
    if (site && site !== 'same-origin' && site !== 'none') return null;
    const d = this.list.find((x) => x.id === c.id);
    if (!d || d.status !== 'active' || !same(sha(c.secret), d.hash)) return null;
    // Password changed since pairing → this device is no longer valid
    if (d.pw && !same(d.pw, this.pwStamp(d.userId))) return null;
    const now = this.now();
    if (now - (d.lastSeen || d.createdAt) > this.settings.idleDays * 86400000) {
      this.remove(d.id, 'expired');
      return null;
    }
    const acc = this.account(d.userId);
    if (!acc) return null;
    d.lastSeen = now; d.lastIp = ipOf(req);
    if (now - (this.saved.get(d.id) || 0) > SEEN_SAVE_MS) { this.saved.set(d.id, now); this.persist(); }
    return { ...acc, until: now + 60000, ip: d.lastIp, device: d.id, deviceName: d.name, via: 'device' };
  }
  cookie(id, secret) { return `${COOKIE}=${id}.${secret}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${400 * 86400}`; }
  clearCookie() { return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`; }
  /** Sign out on a paired device = forget this device (core /logout calls this) → cookie that clears it */
  logout(req) {
    const c = this.fromCookie(req);
    if (!c) return null;
    const d = this.list.find((x) => x.id === c.id);
    if (d && same(sha(c.secret), d.hash)) this.remove(d.id, 'signed-out');
    return this.clearCookie();
  }

  /* ---------------- new devices ---------------- */
  add({ userId, name, ua, ip, via, status }) {
    if (this.list.length >= MAX_DEVICES) throw this.host.error(409, 'Too many paired devices – block a few old ones first.');
    const id = crypto.randomBytes(6).toString('hex');
    const secret = crypto.randomBytes(32).toString('base64url');
    const now = this.now();
    const d = { id, hash: sha(secret), pw: this.pwStamp(userId || undefined), name: clean(name) || deviceLabel(ua), ua: deviceLabel(ua), userId: userId || undefined, via, status, createdAt: now, lastSeen: now, lastIp: ip };
    this.list.push(d);
    this.persist();
    return { device: d, secret };
  }
  /** PC: one-time pairing code for an account ('' = owner). */
  createCode({ userId = '', name = '' } = {}, by = 'admin') {
    const acc = this.account(userId || undefined);
    if (!acc) throw this.host.error(404, 'This account cannot sign in (removed, switched off or expired).');
    const now = this.now();
    for (const [k, v] of this.codes) if (v.until <= now) this.codes.delete(k);
    if (this.codes.size >= MAX_CODES) throw this.host.error(429, 'Too many open pairing codes – wait a few minutes.');
    const code = crypto.randomBytes(16).toString('base64url');
    this.codes.set(sha(code), { userId: userId || undefined, name: clean(name), until: now + CODE_MS, by });
    this.note('code-created', { user: acc.user });
    return { code, until: now + CODE_MS, user: acc.user };
  }
  /**
   * Phone: exchange a pairing code for a device key. The code is gone after the first try.
   * Wrong/old codes count as failed sign-ins of the address (core lockout, remote.fail).
   */
  pair(req, { code, name } = {}) {
    const remote = this.ctx.remote;
    const raw = req.socket && req.socket.remoteAddress;
    const ip = ipOf(req);
    if (!remote || !remote.cfg.enabled) throw this.host.error(403, 'Remote access is switched off.');
    if (remote.locked && remote.locked(raw)) throw this.host.error(429, 'Too many failed attempts – please wait 15 minutes.');
    const key = sha(String(code || ''));
    const c = typeof code === 'string' && /^[A-Za-z0-9_-]{22}$/.test(code) ? this.codes.get(key) : null;
    if (c) this.codes.delete(key);
    if (!c || c.until <= this.now()) {
      if (remote.fail) remote.fail(raw);
      this.note('code-refused', { ip, ua: deviceLabel(req.headers['user-agent']) });
      throw this.host.error(401, 'This pairing code is not valid (any more) – create a new one on the PC.');
    }
    const acc = this.account(c.userId);
    if (!acc) { this.note('code-refused', { ip, why: 'account' }); throw this.host.error(401, 'This account can no longer sign in.'); }
    const { device, secret } = this.add({ userId: c.userId, name: name || c.name, ua: req.headers['user-agent'], ip, via: 'qr', status: 'active' });
    this.note('paired', { device: device.name, user: acc.user, ip });
    this.audit(`Gerät „${device.name}“ für ${acc.user} gekoppelt (QR-Code)`, device.name);
    const en = this.en();
    this.alert(en ? 'Hostwerk app: new device paired' : 'Hostwerk-App: neues Gerät gekoppelt', en ? `„${device.name}“ for ${acc.user} from ${ip}.` : `„${device.name}“ für ${acc.user} von ${ip}.`);
    this.host.broadcast({ type: 'pwa-devices' });
    return { cookie: this.cookie(device.id, secret), device: this.pub(device) };
  }
  /**
   * Phone, signed in normally (core session): keep this phone signed in. Members always wait for the owner's approval;
   * the owner's own phones too while approveNew is on (default) – a stolen password alone is then not enough.
   */
  remember(req, session, { name } = {}) {
    if (!session || !session.user) throw this.host.error(401, 'Please sign in first.');
    if (session.device) { const d = this.list.find((x) => x.id === session.device); if (d) return { device: this.pub(d) }; }
    if (this.list.filter((x) => x.status === 'pending' && (x.userId || '') === (session.userId || '')).length >= MAX_PENDING) throw this.host.error(429, 'This account already has devices waiting for approval – approve or block them on the PC first.');
    // Members have no second factor of their own: their devices always wait for the owner
    const pending = !!session.userId || this.settings.approveNew;
    const { device, secret } = this.add({ userId: session.userId, name, ua: req.headers['user-agent'], ip: ipOf(req), via: 'login', status: pending ? 'pending' : 'active' });
    this.note(pending ? 'waiting' : 'remembered', { device: device.name, user: session.user, ip: device.lastIp });
    if (!pending) this.audit(`Gerät „${device.name}“ für ${session.user} gemerkt`, device.name);
    const en = this.en();
    if (pending) this.alert(en ? 'Hostwerk app: device waits for approval' : 'Hostwerk-App: Gerät wartet auf Freigabe', en ? `„${device.name}“ (${session.user}, ${device.lastIp}) – approve or block it under Go live → Hostwerk app.` : `„${device.name}“ (${session.user}, ${device.lastIp}) – unter Livebetrieb → Hostwerk-App freigeben oder sperren.`);
    this.host.broadcast({ type: 'pwa-devices' });
    return { cookie: this.cookie(device.id, secret), device: this.pub(device) };
  }
  /** State of the device in the cookie (for the phone: pending / active / unknown) */
  mine(req) {
    const c = this.fromCookie(req);
    const d = c ? this.list.find((x) => x.id === c.id) : null;
    return d && same(sha(c.secret), d.hash) ? this.pub(d) : null;
  }
  approve(id) {
    const d = this.list.find((x) => x.id === id);
    if (!d) throw this.host.error(404, 'Device not found.');
    if (d.status !== 'pending') return this.pub(d);
    const acc = this.account(d.userId);
    if (!acc) throw this.host.error(409, 'This account can no longer sign in – block the device instead.');
    d.status = 'active'; d.approvedAt = this.now(); d.lastSeen = this.now();
    this.persist();
    this.note('approved', { device: d.name, user: acc.user });
    this.audit(`Gerät „${d.name}“ für ${acc.user} freigegeben`, d.name);
    this.host.broadcast({ type: 'pwa-devices' });
    return this.pub(d);
  }
  rename(id, name) {
    const d = this.list.find((x) => x.id === id);
    if (!d) throw this.host.error(404, 'Device not found.');
    const n = clean(name);
    if (!n) throw this.host.error(400, 'Please enter a name.');
    d.name = n; this.persist();
    return this.pub(d);
  }
  /** Block = forget the device; its key stops working at once. why: blocked | expired | signed-out | all */
  remove(id, why = 'blocked') {
    const i = this.list.findIndex((x) => x.id === id);
    if (i < 0) return false;
    const [d] = this.list.splice(i, 1);
    this.persist();
    this.saved.delete(id);
    if (this.ctx.remote && typeof this.ctx.remote.dropSessions === 'function') this.ctx.remote.dropSessions((s) => s.device === id);
    const acc = this.account(d.userId);
    this.note(why, { device: d.name, user: acc ? acc.user : null });
    if (why === 'blocked' || why === 'all') this.audit(`Gerät „${d.name}“ gesperrt`, d.name);
    this.host.broadcast({ type: 'pwa-devices' });
    return true;
  }
  removeAll() { let n = 0; for (const d of [...this.list]) if (this.remove(d.id, 'all')) n++; return n; }

  /* ---------------- views ---------------- */
  pub(d) {
    const acc = this.account(d.userId);
    const idleMs = this.settings.idleDays * 86400000;
    return { id: d.id, name: d.name, ua: d.ua, user: acc ? acc.user : null, owner: !d.userId, orphan: !acc, via: d.via, status: d.status, createdAt: d.createdAt, lastSeen: d.lastSeen, lastIp: d.lastIp, approvedAt: d.approvedAt || null, expiresAt: (d.lastSeen || d.createdAt) + idleMs };
  }
  view() {
    return {
      settings: this.settings,
      devices: this.list.map((d) => this.pub(d)).sort((a, b) => (a.status === b.status ? b.lastSeen - a.lastSeen : a.status === 'pending' ? -1 : 1)),
      log: this.log.slice(0, 60),
      accounts: this.accounts(),
      openCodes: [...this.codes.values()].filter((c) => c.until > this.now()).length,
    };
  }
}

module.exports = { Devices, deviceLabel, COOKIE, CODE_MS, DEFAULTS };
