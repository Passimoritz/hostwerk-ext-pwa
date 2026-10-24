'use strict';
/*
 * Native part of the Hostwerk app (web app for phones, paired devices):
 *   provides "devices"   Hostwerk's sign-in asks devices.verify(req) for requests without a session – a paired phone
 *                        stays signed in (see devices.js). Without this extension there are no device keys at all.
 *
 * Signed in on the PC (admin only – Team & roles keeps members away from these routes):
 *   GET    /api/pwa                     devices, settings, security log, accounts that can be paired
 *   POST   /api/pwa/pair                { userId?, name? } → one-time code, link and QR code (5 minutes, used once)
 *   POST   /api/pwa/devices/:id/approve | PUT /api/pwa/devices/:id { name } | DELETE /api/pwa/devices/:id
 *   DELETE /api/pwa/devices             block every device
 *   PUT    /api/pwa/settings            { approveNew, idleDays, alertNew }
 *   GET    /api/pwa/link                address for phones (own domain first) + QR code to the install page
 * Public (/api/x/pwa/pub/…, see pages.js): install page, pairing page, manifest, service worker, icons and
 *   POST /pub/pair      { code, name }  → device key (cookie)
 *   POST /pub/remember  { name }        → keep this phone signed in – needs a normal sign-in on the phone (checked here
 *                                         against Hostwerk's own session; cookies are SameSite, other sites cannot use it)
 *   GET  /pub/me                        state of this phone's device key (active / pending) for the app
 */
const { Devices, deviceLabel } = require('./devices');
const pages = require('./pages');

let devices = null;

/** Addresses under which phones reach this Hostwerk: own domain first, then the home network */
function phoneBases(ctx) {
  const r = ctx.remote;
  if (!r || typeof r.status !== 'function') return [];
  const st = r.status();
  if (!st.running) return [];
  return [...(st.domain ? [`https://${st.domain}${st.port === 443 ? '' : `:${st.port}`}`] : []), ...(st.urls || []).map((u) => u.replace(/\/$/, ''))];
}

function activate(host) {
  const { ctx } = host;
  const express = host.lib('express');
  const json = express.json({ limit: '4kb' });
  devices = new Devices(host);
  host.provide('devices', devices);
  const lang = () => (((ctx.settings.get().general || {}).language) === 'en' ? 'en' : 'de');
  const t = (s, vars) => host.t(s, vars);
  const qr = (text) => host.lib('qrcode').toString(text, { type: 'svg', margin: 1, width: 220 });

  /* ---------- PC (admin) ---------- */
  const r = host.router;
  r.get('/pwa', (req, res) => res.json(devices.view()));
  r.get('/pwa/link', async (req, res) => {
    const st = ctx.remote && ctx.remote.status ? ctx.remote.status() : {};
    const bases = phoneBases(ctx);
    const i = Math.min(Number(req.query.i) || 0, Math.max(0, bases.length - 1));
    const link = bases[i] ? `${bases[i]}${pages.BASE}` : null;
    res.json({ bases, link, svg: link ? await qr(link) : null, running: !!st.running, ready: !!(st.running && st.hasPassword && st.totpOn), hasPassword: !!st.hasPassword, totpOn: !!st.totpOn, domain: st.domain || '', port: st.port });
  });
  r.post('/pwa/pair', json, async (req, res) => {
    const b = req.body || {};
    // A code for the OWNER account only from the owner (or this PC) – not from a member with the role admin
    const s = ctx.remote && !ctx.remote.isLoopback(req) ? ctx.remote.session(req) : null;
    if (!b.userId && s && s.userId) throw host.error(403, 'Only the owner can pair a phone for the owner account.');
    const bases = phoneBases(ctx);
    if (!bases.length) throw host.error(409, 'Switch on remote access first – the phone loads Hostwerk from there.');
    const c = devices.createCode({ userId: typeof b.userId === 'string' ? b.userId : '', name: b.name });
    const i = Math.min(Number(b.i) || 0, bases.length - 1);
    const url = `${bases[i]}${pages.BASE}pair#${c.code}`;
    res.json({ ...c, url, bases, svg: await qr(url) });
  });
  r.post('/pwa/devices/:id/approve', (req, res) => res.json(devices.approve(req.params.id)));
  r.put('/pwa/devices/:id', json, (req, res) => res.json(devices.rename(req.params.id, (req.body || {}).name)));
  r.delete('/pwa/devices/:id', (req, res) => { devices.remove(req.params.id, 'blocked'); res.json(devices.view()); });
  r.delete('/pwa/devices', (req, res) => { devices.removeAll(); res.json(devices.view()); });
  r.put('/pwa/settings', json, (req, res) => { devices.setSettings(req.body || {}); res.json(devices.view()); });

  /* ---------- public ---------- */
  const p = host.publicRouter;
  p.get('/pub/', (req, res) => pages.installPage(req, res, { t, lang: lang() }));
  p.get('/pub', (req, res) => res.redirect(pages.BASE));
  p.get('/pub/pair', (req, res) => pages.pairPage(req, res, { t, lang: lang(), label: deviceLabel(req.headers['user-agent']) }));
  p.post('/pub/pair', json, (req, res) => {
    pages.secure(res);
    const out = devices.pair(req, req.body || {});
    res.setHeader('Set-Cookie', out.cookie);
    res.json({ ok: true, device: out.device });
  });
  p.post('/pub/remember', json, (req, res) => {
    pages.secure(res);
    const s = ctx.remote && ctx.remote.cfg.enabled && !ctx.remote.isLoopback(req) ? ctx.remote.session(req) : null;
    if (!s) throw host.error(401, 'Please sign in first.');
    const out = devices.remember(req, s, req.body || {});
    if (out.cookie) res.setHeader('Set-Cookie', out.cookie);
    res.json({ ok: true, device: out.device });
  });
  p.get('/pub/me', (req, res) => { pages.secure(res); res.json({ device: devices.mine(req), loopback: !!(ctx.remote && ctx.remote.isLoopback(req)) }); });
  p.get('/pub/manifest.webmanifest', (req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.type('application/manifest+json').send(JSON.stringify(pages.manifest({ t, lang: lang() }))); });
  p.get('/pub/sw.js', (req, res) => { res.setHeader('Service-Worker-Allowed', '/'); res.setHeader('Cache-Control', 'no-cache'); res.type('js').send(pages.SW); });
  for (const n of [192, 512]) {
    p.get(`/pub/icon-${n}.png`, (req, res) => { const b = pages.icon(host.dir, n); if (!b) return res.status(404).end(); res.setHeader('Cache-Control', 'public, max-age=86400'); res.type('png').send(b); });
  }
}

function deactivate() { if (devices) devices.persist(); devices = null; }

module.exports = { activate, deactivate, Devices };
