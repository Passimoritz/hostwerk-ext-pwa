'use strict';
/*
 * Public pages of the Hostwerk app (no sign-in, under /api/x/pwa/pub/…):
 *   /pub/                     how to get the app – recognises Android, iPhone or a computer (old address /app-laden)
 *   /pub/pair#<code>          pair this phone: the code from the QR code sits in the fragment (never sent to a server log,
 *                             never in a Referer), the page swaps it for a device key and opens the app
 *   /pub/manifest.webmanifest web app manifest (start #/handy, own icon, no browser bar)
 *   /pub/sw.js                service worker – only so phones can install the app; caches nothing (Hostwerk always shows
 *                             the current state). Service-Worker-Allowed: / – it covers Hostwerk's whole interface.
 * Every page: strict Content Security Policy with a nonce, no framing, no referrer, nothing cached.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const BASE = '/api/x/pwa/pub/';
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Security headers for an HTML page; returns the nonce for its inline script/style. */
function secure(res) {
  const nonce = crypto.randomBytes(16).toString('base64');
  res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  return nonce;
}

const STYLE = `body{margin:0;font:16px/1.5 system-ui,-apple-system,sans-serif;background:#0b0d12;color:#e6e8ef;display:grid;place-items:center;min-height:100vh}
main{max-width:440px;padding:28px 22px}h1{font-size:24px;margin:.2em 0}p{color:#c3c8d6}
.logo{width:56px;height:56px;border-radius:16px;display:block}
.btn{display:block;width:100%;box-sizing:border-box;text-align:center;margin:18px 0;padding:14px;border:0;border-radius:14px;background:#c2410c;color:#fff;font:inherit;font-weight:700;text-decoration:none;cursor:pointer}
.btn[disabled]{opacity:.6}label{display:block;font-size:14px;font-weight:600;margin:14px 0 6px}
input{width:100%;box-sizing:border-box;padding:12px;border-radius:12px;border:1px solid #2c3242;background:#11141c;color:inherit;font:inherit}
ol{padding-left:20px;color:#b6bccb}.note{color:#8a91a3;font-size:13px}.err{background:#3a1518;color:#ffb4ba;padding:10px 12px;border-radius:12px}
.ok{background:#12301f;color:#9fe3b9;padding:10px 12px;border-radius:12px}a{color:#ffb38a}`;

/** Page frame (lang from Hostwerk's language) */
function page({ title, body, nonce, lang, script = '' }) {
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title><link rel="manifest" href="${BASE}manifest.webmanifest"><link rel="icon" href="${BASE}icon-192.png">
<style nonce="${nonce}">${STYLE}</style></head><body><main><img class="logo" src="${BASE}icon-192.png" alt="">${body}</main>${script ? `<script nonce="${nonce}">${script}</script>` : ''}</body></html>`;
}

/** /pub/ – how to get the app on this device */
function installPage(req, res, { t, lang }) {
  const ua = String(req.headers['user-agent'] || '');
  const kind = /android/i.test(ua) ? 'android' : /iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && /mobile/i.test(ua)) ? 'ios' : 'other';
  const open = `<a class="btn" href="/#/handy">${esc(t('Open Hostwerk'))}</a>`;
  const body = kind === 'android'
    ? `<h1>${esc(t('Hostwerk on Android'))}</h1><p>${esc(t('Hostwerk runs as a web app – with its own icon, without the browser bar.'))}</p>${open}
<ol><li>${esc(t('Open it and sign in with your Hostwerk access (or passkey) – or scan a pairing code from the PC.'))}</li><li>${esc(t('In the browser menu ⋮ tap “Install app” or “Add to home screen” – Hostwerk also offers it itself.'))}</li><li>${esc(t('Keep the phone signed in under “More”.'))}</li></ol>`
    : kind === 'ios'
      ? `<h1>${esc(t('Hostwerk on the iPhone'))}</h1><p>${esc(t('Hostwerk runs as a web app – with its own icon, without the browser bar.'))}</p>${open}
<ol><li>${esc(t('Tap Share at the bottom (square with an arrow).'))}</li><li>${esc(t('Choose “Add to Home Screen”.'))}</li><li>${esc(t('Open Hostwerk from there and keep the phone signed in under “More”.'))}</li></ol>`
      : `<h1>${esc(t('Hostwerk for your phone'))}</h1><p>${esc(t('Open this page on your phone (pairing code in Hostwerk → Go live → Hostwerk app). Hostwerk runs there as a web app – the same on Android and iPhone.'))}</p>${open}`;
  const detected = kind === 'android' ? 'Android' : kind === 'ios' ? 'iPhone/iPad' : t('Computer');
  const nonce = secure(res);
  res.type('html').send(page({ title: t('Hostwerk for your phone'), lang, nonce, body: `${body}<p class="note">${esc(t('Detected: {kind}', { kind: detected }))}</p>` }));
}

/** /pub/pair – exchange the code from the fragment for a device key */
function pairPage(req, res, { t, lang, label }) {
  const nonce = secure(res);
  const texts = { busy: t('Pairing …'), ok: t('Paired – Hostwerk opens.'), nocode: t('No pairing code found. Scan the QR code on the PC again.'), fail: t('Pairing failed.') };
  const script = `(function(){
var code=(location.hash||'').slice(1);history.replaceState(null,'',location.pathname);
var T=${JSON.stringify(texts).replace(/</g, '\\u003c')};var msg=document.getElementById('msg'),btn=document.getElementById('go'),name=document.getElementById('name');
function show(k,t){msg.className=k;msg.textContent=t;msg.hidden=false;}
if(!/^[A-Za-z0-9_-]{22}$/.test(code)){btn.disabled=true;show('err',T.nocode);return;}
btn.addEventListener('click',function(){btn.disabled=true;show('note',T.busy);
fetch('${BASE}pair',{method:'POST',headers:{'content-type':'application/json'},credentials:'same-origin',body:JSON.stringify({code:code,name:name.value})})
.then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||T.fail);return j;});})
.then(function(){code='';show('ok',T.ok);setTimeout(function(){location.replace('/#/handy');},700);})
.catch(function(e){code='';show('err',e.message||T.fail);});});})();`;
  const body = `<h1>${esc(t('Pair this phone'))}</h1><p>${esc(t('This phone stays signed in to Hostwerk – with the rights of the account the code was made for. You can block it on the PC at any time.'))}</p>
<label for="name">${esc(t('Name of this device'))}</label><input id="name" maxlength="60" value="${esc(label)}" autocomplete="off">
<button id="go" class="btn" type="button">${esc(t('Pair and open Hostwerk'))}</button><div id="msg" hidden></div>
<p class="note">${esc(t('The code works once and only for 5 minutes.'))}</p>`;
  res.type('html').send(page({ title: t('Pair this phone'), lang, nonce, body, script }));
}

function manifest({ t, lang }) {
  const icons = [192, 512].map((n) => ({ src: `${BASE}icon-${n}.png`, sizes: `${n}x${n}`, type: 'image/png', purpose: 'any' }));
  return {
    id: '/#/handy', name: 'Hostwerk', short_name: 'Hostwerk', description: t('Your local server hub – services, Minecraft, passwords, AI helper'),
    start_url: '/#/handy', scope: '/', display: 'standalone', display_override: ['standalone', 'minimal-ui'], orientation: 'any',
    background_color: '#0e1118', theme_color: '#FF5A1F', lang, categories: ['utilities', 'developer', 'productivity'],
    icons: [...icons, { src: `${BASE}icon-512.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' }],
    shortcuts: [
      { name: t('Services'), url: '/#/handy', icons: [icons[0]] },
      { name: 'Minecraft', url: '/#/mc', icons: [icons[0]] },
      { name: t('AI helper'), url: '/#/ki', icons: [icons[0]] },
    ],
  };
}

const SW = `/* Hostwerk app – service worker only so phones can install Hostwerk. Caches nothing: Hostwerk always shows the current
   state. An old web-push subscription (Hostwerk up to 2.x) is cancelled on activation. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(Promise.all([
  self.clients.claim(),
  self.registration.pushManager ? self.registration.pushManager.getSubscription().then((s) => s && s.unsubscribe()).catch(() => {}) : null,
])));
`;

/** Icons from the package (public/icon-192.png, icon-512.png) */
function icon(dir, n) { const f = path.join(dir, 'public', `icon-${n}.png`); return fs.existsSync(f) ? fs.readFileSync(f) : null; }

module.exports = { BASE, secure, installPage, pairPage, manifest, SW, icon };
