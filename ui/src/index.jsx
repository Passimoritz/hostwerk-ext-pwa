import { useEffect, useMemo, useRef, useState } from 'react';
import { Globe, Database, Box, Boxes, Mail, Play, Square, RotateCw, ListChecks, Bot, Send, AlertTriangle, LayoutDashboard, Users, Pause, Download, Share, Gamepad2, CalendarClock, ScrollText, KeyRound, ShieldCheck, Activity, HeartPulse, History, ChevronRight, Copy, Fingerprint, WifiOff, Smartphone, QrCode, Check, Trash2, Pencil, LogOut, Clock, Lock, Eye, EyeOff, ShieldAlert, RefreshCw } from 'lucide-react';
import { useStore, get, post, put, del, useApi, playerCount, fmtDate, useRefresh, on } from '@hostwerk/api';
import { Btn, Modal, Field, Seg, Switch, SettingRow, Callout, Empty, TileEmpty, Loading, Progress, InfoTip, toast, confirmDialog, promptDialog, useInterval } from '@hostwerk/ui';
import { stopAllGuarded, confirmStopOne, runGate, setStopGate, askAi, EmergencyButton, EmergencyBanner, AiQuotaWidget, HwLogo, Keep, kindText, getLang } from '@hostwerk/kit';
import { t } from '@hostwerk/i18n';
import './style.css';

/*
 * Hostwerk app – Hostwerk on the phone as a web app (PWA) for every phone, without an app store:
 *   screen #/handy   big tap targets, the important things in six tabs (services, players, tasks, passwords, log, more);
 *                    small screens start here (mobileHome). Offline it shows the last known state (read only).
 *   installable      manifest, home-screen icon and service worker come from this extension (public part of the server,
 *                    /api/x/pwa/pub/…) – Hostwerk's core no longer ships them.
 *   paired devices   Go live → Hostwerk app (tab) and "Pair phone …" in the remote access card: one-time QR code,
 *                    device list, approval, blocking, security log. The phone keeps itself signed in under "More".
 *   passkey          dangerous actions (stop everything, stop a service, kick a player) can additionally ask for the
 *                    phone's passkey (fingerprint, face, PIN) – Hostwerk's stop guard calls it (setStopGate).
 */
const BASE = '/api/x/pwa/pub/';

/* ------------------------------------------------------------------ installable (manifest, icon, service worker) */
let installEvent = null;
if (typeof window !== 'undefined') {
  const head = document.head;
  const add = (tag, attrs) => {
    const key = attrs.rel || attrs.name;
    if (head.querySelector(`${tag}[data-hw-pwa="${key}"]`)) return;
    const el = document.createElement(tag);
    el.dataset.hwPwa = key;
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    head.appendChild(el);
  };
  add('link', { rel: 'manifest', href: BASE + 'manifest.webmanifest' });
  add('link', { rel: 'apple-touch-icon', href: BASE + 'icon-192.png' });
  add('meta', { name: 'mobile-web-app-capable', content: 'yes' });
  add('meta', { name: 'apple-mobile-web-app-capable', content: 'yes' });
  add('meta', { name: 'apple-mobile-web-app-title', content: 'Hostwerk' });
  // Only over HTTPS (remote access) – the desktop window and http://localhost need no service worker
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register(`${BASE}sw.js`, { scope: '/' }).catch(() => {});
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; window.dispatchEvent(new Event('hw:installable')); });
}
const standalone = () => typeof window !== 'undefined' && (window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true);

/* ------------------------------------------------------------------ passkey confirmation (per phone) */
const BIO_KEY = 'hw-m-bio';
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = (s) => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const passkeySupported = () => typeof window !== 'undefined' && !!(window.PublicKeyCredential && navigator.credentials);
const bioOn = () => { try { return localStorage.getItem(BIO_KEY) === '1'; } catch { return false; } };
async function passkeyAvailable() {
  if (!passkeySupported()) return false;
  try { return !!(await get('/live/remote/passkeys/confirm')).available; } catch { return false; }
}
/** Confirm once with the passkey → true/false (cancel = false). Same check as the passkey sign-in (core live/passkey.js). */
async function confirmWithPasskey() {
  try {
    const o = await post('/live/remote/passkeys/confirm-options');
    const cred = await navigator.credentials.get({ publicKey: {
      challenge: fromB64u(o.challenge), rpId: o.rpId, timeout: o.timeout, userVerification: 'required',
      allowCredentials: (o.allowCredentials || []).map((c) => ({ ...c, id: fromB64u(c.id) })),
    } });
    if (!cred) return false;
    await post('/live/remote/passkeys/confirm', { id: cred.id, response: { clientDataJSON: b64u(cred.response.clientDataJSON), authenticatorData: b64u(cred.response.authenticatorData), signature: b64u(cred.response.signature) } });
    return true;
  } catch (e) {
    if (e && e.name !== 'NotAllowedError') toast.error(t('Confirmation failed: {msg}', { msg: e.message }));
    return false;
  }
}
function setBio(onOff) {
  try { if (onOff) localStorage.setItem(BIO_KEY, '1'); else localStorage.removeItem(BIO_KEY); } catch { /* blocked */ }
  setStopGate(onOff ? confirmWithPasskey : null);
}
const applyBio = () => setStopGate(bioOn() && passkeySupported() ? confirmWithPasskey : null);

const copy = (text, msg) => navigator.clipboard.writeText(text).then(() => toast.success(msg)).catch(() => toast.error('Copying is not possible'));

/* ================================================================== the phone app (#/handy) */
const STATE = { running: ['running', 'ok'], starting: ['starting', 'warn'], stopping: ['stopping', 'warn'], error: ['Error', 'err'], stopped: ['off', ''], missing: ['missing', ''] };

// Last known state for "offline": without a connection the app shows it with its time (display only, no buttons)
const LAST_KEY = 'hw-m-last';
const readLast = () => { try { return JSON.parse(localStorage.getItem(LAST_KEY) || 'null'); } catch { return null; } };
const writeLast = (o) => { try { localStorage.setItem(LAST_KEY, JSON.stringify({ t: Date.now(), o: { web: o.web, db: o.db, mail: o.mail, kinds: o.kinds, apps: o.apps } })); } catch { /* full or blocked */ } };

const NONE = [];
/** Dienste der Erweiterungs-Arten aus Hostwerks Überblick (overview.kinds, SDK 3.5) */
const kindList = (o) => Object.values((o && o.kinds) || {});
const kindItems = (o) => kindList(o).flatMap((k) => k.items || NONE);
const mcServers = (o) => (o && o.kinds && o.kinds.mc && o.kinds.mc.items) || NONE;

function Row({ icon: I, name, sub, state, base, color, href, svc, offline }) {
  const [busy, setBusy] = useState(false);
  const running = ['running', 'starting'].includes(state);
  const [label, kind] = STATE[state] || [state, ''];
  const act = async (a) => {
    // Stopping and restarting disconnect visitors/players – on the phone always ask (mis-taps happen quickly)
    if (a === 'stop' && !(await confirmStopOne(svc, name, { always: true }))) return;
    if (a === 'restart' && !((await confirmDialog({ title: t('Restart {name}?', { name }), text: 'The service is unreachable for a moment.', confirm: 'Restart' })) && (await runGate()))) return;
    setBusy(true); try { await post(`${base}/${a}`); } catch (e) { toast.error(e.message); } setBusy(false);
  };
  return (
    <div className={`m-row ${state}`}>
      <span className="m-ico" style={color ? { background: color } : undefined}><I size={18} /></span>
      <div className="grow" style={{ minWidth: 0 }} onClick={() => { if (href) location.hash = href; }}><b className="ellipsis"><Keep>{name}</Keep></b><div className="tiny muted ellipsis"><Keep>{sub}</Keep></div></div>
      <span className={`m-state ${kind}`}>{label}</span>
      {state !== 'missing' && !offline && (running
        ? <><button className="m-btn" disabled={busy} title="Restart" aria-label="Restart" onClick={() => act('restart')}><RotateCw size={18} /></button><button className="m-btn danger" disabled={busy} title="Stop" aria-label="Stop" onClick={() => act('stop')}><Square size={18} /></button></>
        : <button className="m-btn primary" disabled={busy} title="Start" aria-label="Start" onClick={() => act('start')}><Play size={18} /></button>)}
    </div>
  );
}

function InstallCard() {
  const [can, setCan] = useState(!!installEvent);
  useEffect(() => { const f = () => setCan(true); window.addEventListener('hw:installable', f); return () => window.removeEventListener('hw:installable', f); }, []);
  if (standalone()) return null;
  const ios = /iPhone|iPad/.test(navigator.userAgent);
  return (
    <section className="m-card">
      <h3><Download size={16} />Install as an app</h3>
      {can ? <button className="m-big primary" onClick={async () => { const e = installEvent; if (!e) return; e.prompt(); const r = await e.userChoice; if (r.outcome === 'accepted') { toast.success('Installed – open it from the home screen from now on'); setCan(false); } }}><Download size={18} />Install now</button>
        : ios ? <div className="small muted"><Share size={14} /> Tap <b>Share</b> at the bottom → <b>Add to Home Screen</b>. Hostwerk then starts with its own icon.</div>
          : <div className="small muted">In the browser menu <b>⋮</b> tap <b>Install app</b> or <b>Add to home screen</b>.</div>}
    </section>
  );
}

/** Keep this phone signed in (device key) – or show that it waits for approval; sign out = forget this phone. */
function DeviceCard() {
  const [me, setMe] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = () => get('/x/pwa/pub/me').then(setMe).catch(() => setMe({ device: null }));
  useEffect(() => { load(); }, []);
  useInterval(() => { if (me && me.device && me.device.status === 'pending') load(); }, 15000);
  if (!me || me.loopback) return null;
  const d = me.device;
  const signOut = async () => {
    if (!(await confirmDialog({ title: 'Sign out on this phone?', text: d ? 'This phone is forgotten – to use it again, sign in or pair it once more.' : 'You need to sign in again next time.', confirm: 'Sign out' }))) return;
    try { await fetch('/logout', { method: 'POST', credentials: 'same-origin' }); } catch { /* the sign-in page follows anyway */ }
    location.href = '/login';
  };
  return (
    <section className="m-card">
      <h3><Smartphone size={16} />This phone</h3>
      {d && d.status === 'active' && <div className="small"><span className="m-state ok">signed in</span> {t('Stays signed in as {user} – unused for a long time it expires on its own.', { user: d.user || '?' })}</div>}
      {d && d.status === 'pending' && <div className="small"><span className="m-state warn">waits</span> Waiting for approval on the PC (Go live → Hostwerk app). Until then the normal sign-in applies.</div>}
      {!d && (
        <>
          <div className="small muted">Without this, the sign-in ends after 12 hours. With it, this phone stays signed in like an app – you can block it on the PC at any time.</div>
          <button className="m-big primary" disabled={busy} onClick={async () => { setBusy(true); try { const r = await post('/x/pwa/pub/remember', {}); setMe({ device: r.device }); toast.success(r.device.status === 'pending' ? 'Asked for approval on the PC' : 'This phone stays signed in'); } catch (e) { toast.error(e.message); } setBusy(false); }}><ShieldCheck size={18} />Keep this phone signed in</button>
        </>
      )}
      <button className="m-big" onClick={signOut}><LogOut size={18} />Sign out</button>
    </section>
  );
}

function ServicesTab({ o, jobs, offline }) {
  const apps = o.apps || [];
  const all = [...o.web, ...o.db, o.mail, ...kindItems(o), ...apps];
  const running = all.filter((s) => s.proc.state === 'running').length;
  const errors = all.filter((s) => s.proc.state === 'error');
  const players = kindItems(o).reduce((n, s) => n + playerCount(s), 0);
  const runningJobs = Object.values(jobs).filter((j) => j.state === 'running');
  const startAll = async () => { try { const r = await post('/start-all'); if (r.errors.length) toast.error(r.errors.join('\n')); else toast.success('Everything started'); } catch (e) { toast.error(e.message); } };
  return (
    <>
      <div className="m-stats">
        <div><b>{running}</b><span>active</span></div>
        <div className={errors.length ? 'err' : ''}><b>{errors.length}</b><span>errors</span></div>
        <div><b>{players}</b><span>players</span></div>
        <div><b>{o.mail.unread}</b><span>new mails</span></div>
      </div>
      {!offline && <div className="m-actions">
        <button className="m-big primary" onClick={startAll}><Play size={18} />Start everything</button>
        <button className="m-big" disabled={!running} onClick={() => stopAllGuarded()}><Square size={18} />Stop everything</button>
      </div>}
      {errors.length > 0 && <section className="m-card err"><h3><AlertTriangle size={16} />Needs help</h3>{errors.map((x) => <div key={x.name} className="small"><b><Keep>{x.name}</Keep></b> – <Keep>{x.proc.hint ? x.proc.hint.title : x.proc.error}</Keep> <button className="m-btn sm" title="Ask the AI helper" aria-label="Ask the AI helper" onClick={() => { askAi(t('{name} does not start: {error}', { name: x.name, error: x.proc.error || '' }), null, 'doktor'); location.hash = '/ki'; }}><Bot size={14} /></button></div>)}</section>}
      {runningJobs.length > 0 && <section className="m-card"><h3><ListChecks size={16} />Running in the background</h3>{runningJobs.map((j) => <div key={j.id} className="m-job"><div className="row-tight"><span className="grow small ellipsis"><Keep>{j.title}</Keep></span>{j.canPause && <button className="m-btn sm" title={j.paused ? 'Continue' : 'Pause'} aria-label={j.paused ? 'Continue' : 'Pause'} onClick={() => post(`/jobs/${j.id}/${j.paused ? 'resume' : 'pause'}`)}>{j.paused ? <Play size={14} /> : <Pause size={14} />}</button>}</div><Progress value={j.progress} indeterminate={!j.progress && !j.paused} /></div>)}</section>}
      {o.web.length > 0 && <section className="m-card"><h3><Globe size={16} />Web servers</h3>{o.web.map((w) => <Row key={w.id} icon={Globe} color={w.color} name={w.name} sub={t('Port {port}', { port: w.httpPort })} state={w.installed ? w.proc.state : 'missing'} base={`/web/${w.id}`} href={`/web/${w.id}`} svc={w} offline={offline} />)}</section>}
      {o.db.length > 0 && <section className="m-card"><h3><Database size={16} />Databases</h3>{o.db.map((d) => <Row key={d.id} icon={Database} color={d.color} name={d.name} sub={`${d.typeLabel} · ${t('Port {port}', { port: d.port })}`} state={d.installed ? d.proc.state : 'missing'} base={`/dbs/${d.id}`} href={`/dbs/${d.id}`} svc={d} offline={offline} />)}</section>}
      {kindList(o).filter((k) => (k.items || NONE).length).map((k) => <section key={k.kind} className="m-card"><h3><Box size={16} /><Keep>{kindText(k.label, getLang()) || k.kind}</Keep></h3>{k.items.map((s) => { const p = s.proc || {}; const n = playerCount(s); return <Row key={s.id} icon={Box} color={k.color} name={s.name} sub={p.state === 'running' && n ? t('{n} players', { n }) : s.detail || [s.typeLabel, s.version].filter(Boolean).join(' ')} state={p.state || 'stopped'} base={k.api ? `${k.api}/${s.id}` : null} href={k.route ? `${k.route}/${s.id}` : null} svc={s} offline={offline} />; })}</section>)}
      {apps.length > 0 && <section className="m-card"><h3><Boxes size={16} />Apps</h3>{apps.map((a) => <Row key={a.id} icon={Boxes} name={a.name} sub={a.kindLabel} state={a.proc.state} base={`/apps/${a.id}`} href={`/apps/${a.id}`} svc={a} offline={offline} />)}</section>}
      {o.mail && <section className="m-card"><h3><Mail size={16} />Mail catcher</h3><Row icon={Mail} name={t('Mail catcher')} sub={t('{count} mails · {unread} unread', { count: o.mail.count, unread: o.mail.unread })} state={o.mail.proc.state} base="/mail" href="/mail" svc={o.mail} offline={offline} /></section>}
    </>
  );
}

function PlayersTab({ o }) {
  const [cmd, setCmd] = useState({});
  const [games, setGames] = useState(null);
  useEffect(() => { get('/games').then(setGames).catch(() => setGames({ servers: [] })); }, []);
  const servers = mcServers(o);
  const sendCmd = async (s) => { const c = (cmd[s.id] || '').trim(); if (!c) return; try { await post(`/mc/servers/${s.id}/command`, { command: c }); toast.success('Sent'); setCmd({ ...cmd, [s.id]: '' }); } catch (e) { toast.error(e.message); } };
  if (!servers.length && !(games && games.servers.length)) return <section className="m-card"><div className="small muted">No game servers set up.</div></section>;
  return (
    <>
      {servers.map((s) => {
        const pl = s.proc.extra.players || [];
        return (
          <section key={s.id} className="m-card">
            <h3><Box size={16} /><Keep>{s.name}</Keep> <span className="tiny muted">{s.proc.state === 'running' ? `${t('{n} online', { n: playerCount(s) })}${s.proc.extra.tps != null ? ` · TPS ${s.proc.extra.tps}` : ''}` : t('off')}</span></h3>
            {pl.length > 0 && <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>{pl.map((p) => <button type="button" key={p} className="chip" title={t('Kick {player} from the server', { player: p })} onClick={async () => { if ((await confirmDialog({ title: t('Kick {player} from the server?', { player: p }), text: 'The player is disconnected and can join again afterwards.', confirm: 'Kick', danger: true })) && (await runGate())) { await post(`/mc/servers/${s.id}/command`, { command: 'kick ' + p }).then(() => toast.success(t('{player} was kicked from the server', { player: p }))).catch((e) => toast.error(e.message)); } }}><Keep>{p}</Keep></button>)}</div>}
            {s.proc.state === 'running' && <form className="row" style={{ gap: 6, marginTop: 8 }} onSubmit={(e) => { e.preventDefault(); sendCmd(s); }}><input className="input grow" placeholder="Command (e.g. say Hello, whitelist add Name)" aria-label="Command" value={cmd[s.id] || ''} onChange={(e) => setCmd({ ...cmd, [s.id]: e.target.value })} /><button className="m-btn primary" type="submit" title="Send" aria-label="Send"><Send size={16} /></button></form>}
            <div className="row" style={{ gap: 6, marginTop: 8, flexWrap: 'wrap' }}><a className="m-btn sm" href={`#/mc/${s.id}/players`}>Manage players <ChevronRight size={14} /></a><a className="m-btn sm" href={`#/mc/${s.id}/console`}>Console</a><a className="m-btn sm" href={`#/mc/${s.id}/backups`}>Backups</a></div>
          </section>
        );
      })}
      {games && games.servers.length > 0 && <section className="m-card"><h3><Gamepad2 size={16} />Game servers</h3>{games.servers.map((g) => <Row key={g.id} icon={Gamepad2} name={g.name} sub={g.script} state={g.installed ? (g.running ? 'running' : 'stopped') : 'missing'} base={`/games/${g.id}`} href={`/spiele/${g.id}`} />)}</section>}
    </>
  );
}

function TasksTab() {
  const [d, setD] = useState(null);
  const load = () => get('/tasks').then(setD).catch(() => setD({ list: [] }));
  useEffect(() => { load(); }, []);
  useRefresh(load); // reload quietly after installing/changing/finished jobs
  if (!d) return <section className="m-card"><div className="small muted"><span className="hw-spinner hw-sm" aria-hidden="true" /> Loading …</div></section>;
  return (
    <section className="m-card">
      <h3><CalendarClock size={16} />Tasks {d.paused && <span className="m-state warn">paused</span>}</h3>
      {d.list.length === 0 && <div className="small muted">No tasks.</div>}
      {d.list.map((x) => <div key={x.id} className="m-row"><div className="grow" style={{ minWidth: 0 }}><b className="ellipsis"><Keep>{x.name}</Keep></b><div className="tiny muted ellipsis">{x.lastRun ? `${t('last {when}', { when: fmtDate(x.lastRun) })} · ${x.lastStatus === 'error' ? t('Error') : 'ok'}` : t('never ran yet')}{x.next ? ` · ${t('next {when}', { when: fmtDate(x.next) })}` : ''}</div></div><button className="m-btn primary" title="Run now" aria-label="Run now" onClick={async () => { try { const r = await post(`/tasks/${x.id}/run`); if (r.status === 'error') toast.error('Failed'); else toast.success('Done'); load(); } catch (e) { toast.error(e.message); } }}><Play size={16} /></button></div>)}
      <a className="m-btn sm" href="#/aufgaben" style={{ marginTop: 8 }}>All tasks <ChevronRight size={14} /></a>
    </section>
  );
}

const LOG_FILTERS = [['alle', 'Everything'], ['vorfaelle', 'Incidents'], ['aenderungen', 'Changes'], ['gesundheit', 'Health']];

function LogTab() {
  const [inc, setInc] = useState(null);
  const [health, setHealth] = useState(null);
  const [audit, setAudit] = useState(null);
  const [q, setQ] = useState('');
  const [f, setF] = useState(() => { try { return localStorage.getItem('hw-m-logf') || 'alle'; } catch { return 'alle'; } });
  useEffect(() => { get('/incidents').then(setInc).catch(() => setInc([])); get('/health').then(setHealth).catch(() => {}); get('/audit?limit=60').then(setAudit).catch(() => {}); }, []);
  useEffect(() => { try { localStorage.setItem('hw-m-logf', f); } catch { /* blocked */ } }, [f]);
  const latest = health && health.latest;
  // Search over names, message and action – not case-sensitive
  const needle = q.trim().toLowerCase();
  const hit = (...parts) => !needle || parts.filter(Boolean).join(' ').toLowerCase().includes(needle);
  const show = (k) => f === 'alle' || f === k;
  const incShown = (inc || []).filter((x) => hit(x.name, x.svc, x.title, x.error));
  const auditShown = audit ? audit.items.filter((e) => hit(e.target, e.action, e.via)) : [];
  return (
    <>
      <section className="m-card m-filter">
        <input className="input" type="search" placeholder="Search the log …" aria-label="Search the log" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="m-chips" role="group" aria-label="Filter">{LOG_FILTERS.map(([id, l]) => <button key={id} type="button" className={`chip ${f === id ? 'on' : ''}`} aria-pressed={f === id} onClick={() => setF(id)}>{l}</button>)}</div>
      </section>
      {show('gesundheit') && latest && <section className="m-card"><h3><HeartPulse size={16} />Health <span className={`m-state ${latest.score >= 85 ? 'ok' : latest.score >= 60 ? 'warn' : 'err'}`}>{latest.score}/100</span></h3>{latest.problems.slice(0, 5).map((p, i) => <div key={i} className="small">• <Keep>{p.text}</Keep></div>)}{latest.problems.length === 0 && <div className="small muted">All fine.</div>}<a className="m-btn sm" href="#/system/zustand/gesundheit" style={{ marginTop: 8 }}>Report <ChevronRight size={14} /></a></section>}
      {show('vorfaelle') && <section className="m-card"><h3><AlertTriangle size={16} />Incidents</h3>{!inc ? <div className="small muted"><span className="hw-spinner hw-sm" aria-hidden="true" /> Loading …</div> : incShown.length === 0 ? <div className="small muted">{needle ? 'Nothing found.' : 'No incidents.'}</div> : incShown.slice(0, needle ? 30 : 8).map((x) => <div key={x.id || x.t} className="small"><b><Keep>{x.name || x.svc}</Keep></b> – <Keep>{x.title || x.error}</Keep> <span className="tiny muted">{fmtDate(x.t || x.at)}</span></div>)}</section>}
      {show('aenderungen') && audit && <section className="m-card"><h3><History size={16} />Latest changes</h3>{auditShown.length === 0 ? <div className="small muted">{needle ? 'Nothing found.' : 'None yet.'}</div> : auditShown.slice(0, needle ? 60 : 15).map((e) => <div key={e.id} className="small"><Keep><b>{e.target}</b> {e.action}</Keep> <span className="tiny muted">{fmtDate(e.t)} · <Keep>{e.via}</Keep></span></div>)}</section>}
      <a className="m-btn sm" href="#/system/protokolle"><ScrollText size={14} /> All logs</a>
    </>
  );
}

/** Shared with me – for members (passwords the owner shares with them) */
function SharedWithMe() {
  const [d, setD] = useState(null);
  const [shown, setShown] = useState({});
  const [codes, setCodes] = useState({});
  const load = () => get('/pw/shared/mine').then(setD).catch((e) => setD({ items: [], error: e.message }));
  useEffect(() => { load(); }, []);
  useInterval(() => { get('/pw/shared/mine').then(setD).catch(() => {}); }, 20000);
  const clip = async (text, msg) => { try { await navigator.clipboard.writeText(text); toast.success(msg); setTimeout(() => navigator.clipboard.writeText('').catch(() => {}), 45000); } catch { toast.error('Copying is not possible'); } };
  const act = async (x, what) => {
    try {
      const r = await post('/pw/shared/mine/reveal', { key: x.key });
      if (what === 'user') return clip(r.username, 'User name copied');
      if (what === 'pass') return clip(r.password, 'Password copied – cleared after 45 s');
      if (what === 'show') { setShown((s) => ({ ...s, [x.key]: r.password })); setTimeout(() => setShown((s) => { const n = { ...s }; delete n[x.key]; return n; }), 20000); return undefined; }
      if (what === 'totp' && r.totp) { setCodes((c) => ({ ...c, [x.key]: r.totp })); return clip(r.totp.code, '2FA code copied'); }
    } catch (e) { toast.error(e.message); }
    return undefined;
  };
  if (!d) return <div className="small muted"><span className="hw-spinner hw-sm" aria-hidden="true" /> Loading …</div>;
  if (!d.items.length) return <div className="small muted">When someone shares an access with you, it appears here.</div>;
  return d.items.map((x) => (x.locked ? (
    <div key={x.key} className="m-row muted"><Lock size={14} /><span className="grow small">{t('An entry from “{vault}” – the vault is locked right now.', { vault: x.vaultName })}</span></div>
  ) : (
    <div key={x.key} className="m-row">
      <div className="grow" style={{ minWidth: 0 }}><b className="ellipsis"><Keep>{x.name}</Keep></b><div className="tiny muted ellipsis"><Keep>{x.username}</Keep></div>{shown[x.key] && <div className="mono small"><Keep>{shown[x.key]}</Keep></div>}{codes[x.key] && <div className="mono small">2FA: {codes[x.key].code}</div>}</div>
      {x.username && <button className="m-btn sm" title="Copy user name" aria-label="Copy user name" onClick={() => act(x, 'user')}><Copy size={15} /></button>}
      <button className="m-btn sm" title="Copy password" aria-label="Copy password" onClick={() => act(x, 'pass')}><KeyRound size={15} /></button>
      {x.mode === 'read' && <button className="m-btn sm" title={shown[x.key] ? 'Hide' : 'Show (20 s)'} aria-label={shown[x.key] ? 'Hide' : 'Show (20 s)'} onClick={() => (shown[x.key] ? setShown((s) => { const n = { ...s }; delete n[x.key]; return n; }) : act(x, 'show'))}>{shown[x.key] ? <EyeOff size={15} /> : <Eye size={15} />}</button>}
      {x.hasTotp && <button className="m-btn sm" title="Copy 2FA code" aria-label="Copy 2FA code" onClick={() => act(x, 'totp')}>2FA</button>}
    </div>
  )));
}

/** Passwords on the phone: unlock the vault, search, copy, 2FA codes – members see what is shared with them. */
function PwTab() {
  const [me, setMe] = useState(null);
  const [d, setD] = useState(null);
  const [vid, setVid] = useState(null);
  const [items, setItems] = useState(null);
  const [q, setQ] = useState('');
  const [master, setMaster] = useState('');
  const [codes, setCodes] = useState({});
  const load = () => get('/pw').then((r) => { setD(r); const v = r.instances.find((i) => i.id === r.defaultId) || r.instances[0]; setVid((cur) => cur || (v && v.id)); }).catch(() => setD({ instances: [] }));
  useEffect(() => { get('/pw/shared/mine').then((r) => { setMe(r); if (!r.member) load(); }).catch(() => { setMe({ member: false }); load(); }); }, []);
  const v = d && d.instances.find((i) => i.id === vid);
  useEffect(() => { if (!v || v.locked) { setItems(null); return undefined; } const tm = setTimeout(() => get(`/pw/${v.id}/items?q=${encodeURIComponent(q)}`).then((r) => setItems(Array.isArray(r) ? r : r.items || [])).catch(() => setItems([])), 200); return () => clearTimeout(tm); }, [v && v.id, v && v.locked, q]); // eslint-disable-line react-hooks/exhaustive-deps
  const full = (it) => get(`/pw/${v.id}/items/${it.id}`);
  if (!me) return <section className="m-card"><div className="small muted"><span className="hw-spinner hw-sm" aria-hidden="true" /> Loading …</div></section>;
  if (me.member) return <section className="m-card"><h3><KeyRound size={16} />Shared with me</h3><SharedWithMe /></section>;
  if (!d) return <section className="m-card"><div className="small muted"><span className="hw-spinner hw-sm" aria-hidden="true" /> Loading …</div></section>;
  if (!d.instances.length) return <section className="m-card"><h3><KeyRound size={16} />Passwords</h3><div className="small muted">No vault yet – create one in the full view under Passwords.</div></section>;
  return (
    <section className="m-card">
      <h3><KeyRound size={16} />Passwords</h3>
      {d.instances.length > 1 && <select className="select" aria-label="Vault" value={vid || ''} onChange={(e) => { setVid(e.target.value); setItems(null); }}>{d.instances.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select>}
      {v && v.locked ? (
        <form className="stack" style={{ gap: 8, marginTop: 8 }} onSubmit={async (e) => { e.preventDefault(); try { await post(`/pw/${v.id}/unlock`, { password: master }); setMaster(''); load(); } catch (er) { toast.error(er.message); } }}>
          <input className="input" type="password" autoComplete="current-password" placeholder="Master password" aria-label="Master password" value={master} onChange={(e) => setMaster(e.target.value)} />
          <button className="m-btn primary" type="submit" disabled={!master}><KeyRound size={16} /> Unlock</button>
        </form>
      ) : (
        <>
          <input className="input" style={{ marginTop: 8 }} placeholder="Search …" aria-label="Search" value={q} onChange={(e) => setQ(e.target.value)} />
          {!items ? <div className="small muted"><span className="hw-spinner hw-sm" aria-hidden="true" /> Loading …</div> : items.length === 0 ? <div className="small muted">Nothing found.</div> : items.slice(0, 60).map((it) => (
            <div key={it.id} className="m-row">
              <div className="grow" style={{ minWidth: 0 }}><b className="ellipsis"><Keep>{it.name}</Keep></b><div className="tiny muted ellipsis"><Keep>{it.username}{codes[it.id] ? ` · 2FA ${codes[it.id]}` : ''}</Keep></div></div>
              {it.username && <button className="m-btn sm" title="Copy user name" aria-label="Copy user name" onClick={() => copy(it.username, 'User name copied')}><Copy size={15} /></button>}
              <button className="m-btn sm" title="Copy password" aria-label="Copy password" onClick={async () => { try { const f = await full(it); copy(f.password || '', 'Password copied'); } catch (e) { toast.error(e.message); } }}><KeyRound size={15} /></button>
              {it.hasTotp && <button className="m-btn sm" title="2FA code" aria-label="2FA code" onClick={async () => { try { const x = await get(`/pw/${v.id}/items/${it.id}/totp`); if (x.code) { setCodes((c) => ({ ...c, [it.id]: x.code })); copy(x.code, '2FA code copied'); } } catch (e) { toast.error(e.message); } }}>2FA</button>}
            </div>
          ))}
        </>
      )}
    </section>
  );
}

/** Reachability of all checks, public status page (on/off, link) and the emergency button. */
function StatusCard() {
  const [up, setUp] = useState(null); const [sp, setSp] = useState(null);
  const load = () => { get('/live/uptime').then(setUp).catch(() => setUp({ checks: [] })); get('/live/statuspage').then(setSp).catch(() => setSp(null)); };
  useEffect(load, []);
  useRefresh(load);
  const checks = (up && up.checks) || []; const down = checks.filter((c) => c.ok === false);
  const link = sp && sp.on && sp.links ? (sp.links.public[0] || sp.links.local) : null;
  return (
    <section className="m-card"><h3><Activity size={16} />Reachability</h3>
      {!up ? <div className="muted small">…</div> : !checks.length ? <div className="muted small">No checks yet (Go live → Monitoring).</div> : (
        <div className={`small ${down.length ? 'c-err' : 'c-ok'}`}>{down.length ? t('{n} unreachable: {names}', { n: down.length, names: down.map((c) => c.name).join(', ') }) : t('All {n} reachable', { n: checks.length })}</div>
      )}
      {sp && <div className="row" style={{ marginTop: 8, gap: 8, flexWrap: 'wrap' }}>
        <span className="small grow">{sp.on ? t('Public status page: on') : t('Public status page: off')}</span>
        {link && <button className="m-btn" title="Copy link" aria-label="Copy link" onClick={() => copy(link, 'Link copied')}><Copy size={18} /></button>}
      </div>}
      <div className="row" style={{ marginTop: 10 }}><EmergencyButton /></div>
    </section>
  );
}

/** Confirm dangerous actions additionally with the passkey – only shown if the phone can do passkeys. */
function BioCard() {
  const [onOff, setOnOff] = useState(bioOn);
  const [avail, setAvail] = useState(null);
  useEffect(() => { passkeyAvailable().then(setAvail); }, []);
  if (!passkeySupported()) return null;
  return (
    <section className="m-card"><h3><Fingerprint size={16} />Confirm with fingerprint</h3>
      <div className="row" style={{ gap: 8 }}>
        <span className="small grow">Also confirm “stop everything”, stopping services and kicking players with the passkey.</span>
        <Switch checked={onOff} disabled={!avail && !onOff} label="Confirm with passkey" onChange={(v) => { setBio(v); setOnOff(v); }} />
      </div>
      {avail === false && !onOff && <div className="tiny muted" style={{ marginTop: 6 }}>There is no passkey for this address yet – set one up in the full view under Go live → Remote access.</div>}
    </section>
  );
}

function MoreTab({ q, setQ }) {
  return (
    <>
      <InstallCard />
      <DeviceCard />
      <BioCard />
      <EmergencyBanner />
      <StatusCard />
      <section className="m-card"><h3><Bot size={16} />AI quotas</h3><AiQuotaWidget /></section>
      <section className="m-card">
        <h3><Bot size={16} />Ask the AI helper</h3>
        <form className="row" style={{ gap: 8 }} onSubmit={(e) => { e.preventDefault(); if (q.trim()) { askAi(q.trim()); location.hash = '/ki'; } }}>
          <input className="input grow" placeholder="e.g. Is everything running?" aria-label="Ask the AI helper" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="m-btn primary" type="submit" title="Send" aria-label="Send" disabled={!q.trim()}><Send size={18} /></button>
        </form>
      </section>
      <section className="m-card"><h3><LayoutDashboard size={16} />More areas</h3>
        <div className="m-grid">
          {[['/passwoerter', KeyRound, 'Passwords'], ['/live/sicherheit', ShieldCheck, 'Security'], ['/system/ressourcen', Activity, 'Resources'], ['/mail', Mail, 'Email'], ['/ki', Bot, 'AI chat'], ['/', LayoutDashboard, 'Full view']].map(([h, I, l]) => <a key={h} className="m-tile" href={`#${h}`}><I size={20} /><span>{l}</span></a>)}
        </div>
      </section>
      <div className="tiny muted" style={{ textAlign: 'center', padding: '8px 0 24px' }}><Users size={11} /> The full interface adapts to the phone – the sidebar becomes a toolbar.</div>
    </>
  );
}

function PhoneApp() {
  const live = useStore((s) => s.overview);
  // Your name (Settings → General), only with the greeting switched on
  const greetName = useStore((s) => { const y = s.settings && s.settings.general && s.settings.general.you; return y && y.name && y.greet !== false ? y.name : null; });
  const jobs = useStore((s) => s.jobs);
  const connected = useStore((s) => s.connected);
  const [q, setQ] = useState('');
  const [tab, setTab] = useState(() => { try { return localStorage.getItem('hw-m-tab') || 'dienste'; } catch { return 'dienste'; } });
  useEffect(() => { try { localStorage.setItem('hw-m-tab', tab); } catch { /* blocked */ } }, [tab]);
  useEffect(() => { applyBio(); return () => setStopGate(null); }, []);
  // Connected: remember the state (at most every 30 s); without a connection show the remembered state
  const saved = useRef(0);
  useEffect(() => { if (live && connected && Date.now() - saved.current > 30000) { saved.current = Date.now(); writeLast(live); } }, [live, connected]);
  const last = useMemo(() => (connected ? null : readLast()), [connected]);
  const o = live || (last && last.o ? { ...last.o, apps: last.o.apps || [] } : null);
  const offline = !connected;
  if (!o) return <div className="m-page"><div className="m-card muted">{connected ? 'Connecting …' : 'No connection – and no remembered state yet.'}</div></div>;
  const all = [...o.web, ...o.db, o.mail, ...kindItems(o), ...(o.apps || [])].filter(Boolean);
  const running = all.filter((s) => s.proc.state === 'running').length;
  const TABS = [['dienste', LayoutDashboard, 'Services'], ['spieler', Users, 'Players'], ['aufgaben', CalendarClock, 'Tasks'], ['passwoerter', KeyRound, 'Passwords'], ['protokoll', ScrollText, 'Log'], ['mehr', Bot, 'More']];
  return (
    <div className="m-page">
      <header className="m-head">
        <HwLogo size={28} />
        <div className="grow"><b>{greetName ? <>Hello<Keep>{`, ${greetName}`}</Keep></> : 'Hostwerk'}</b><div className="tiny muted">{connected ? t('{running} of {all} services running', { running, all: all.length }) : t('Connection lost …')}</div></div>
        <a className="m-btn" href="#/" title="Full view" aria-label="Full view"><LayoutDashboard size={18} /></a>
      </header>
      {offline && <div className="m-card m-offline" role="status"><WifiOff size={16} /><span className="small">{last ? t('Offline – last state from {when}', { when: fmtDate(last.t) }) : t('Offline – buttons work again once connected.')}</span></div>}
      {tab === 'dienste' && <ServicesTab o={o} jobs={jobs} offline={offline} />}
      {tab === 'spieler' && <PlayersTab o={o} />}
      {tab === 'aufgaben' && <TasksTab />}
      {tab === 'protokoll' && <LogTab />}
      {tab === 'passwoerter' && <PwTab />}
      {tab === 'mehr' && <MoreTab q={q} setQ={setQ} />}
      <nav className="m-tabs" aria-label="Areas">{TABS.map(([id, I, l]) => <button key={id} className={tab === id ? 'on' : ''} aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}><I size={20} /><span>{l}</span></button>)}</nav>
    </div>
  );
}

/* ================================================================== on the PC: pairing, devices, security */
/** Remote access is missing: the phone loads Hostwerk from there – switch it on here or go to the setup. */
function NeedRemote({ link }) {
  const ready = link.hasPassword && link.totpOn;
  return (
    <Callout kind="info" title="Remote access is still off">
      <div className="small">The phone loads the app and the interface straight from your Hostwerk – for that, remote access has to run (password and two-factor sign-in).</div>
      <div className="row-tight" style={{ marginTop: 8 }}>
        {ready ? <Btn className="primary sm" onClick={async () => { try { await put('/live/remote', { enabled: true }); toast.success('Remote access switched on'); window.dispatchEvent(new Event('hw:pwa-reload')); } catch (e) { toast.error(e.message); } }}>Switch on remote access now</Btn>
          : <a className="btn primary sm" href="#/live/fernzugriff">{link.hasPassword ? 'Set up two-factor sign-in' : 'Set up password and two-factor sign-in'}</a>}
      </div>
    </Callout>
  );
}

/** Pair a phone: one-time QR code for an account (owner or member), live countdown */
function PairPanel({ accounts }) {
  const link = useApi('/pwa/link', [], { live: false });
  const [userId, setUserId] = useState('');
  const [code, setCode] = useState(null);
  const [left, setLeft] = useState(0);
  const [i, setI] = useState(0);
  useEffect(() => { const f = () => link.reload(); window.addEventListener('hw:pwa-reload', f); return () => window.removeEventListener('hw:pwa-reload', f); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useInterval(() => { if (code) { const s = Math.max(0, Math.round((code.until - Date.now()) / 1000)); setLeft(s); if (!s) setCode(null); } }, 1000);
  // Paired on the phone → the code is used up: hide it
  useEffect(() => on('pwa-devices', () => setCode(null)), []);
  if (!link.data) return <Loading />;
  const l = link.data;
  if (!l.ready) return <NeedRemote link={l} />;
  const make = async () => { try { const c = await post('/pwa/pair', { userId, i }); setCode(c); setLeft(Math.round((c.until - Date.now()) / 1000)); } catch (e) { toast.error(e.message); } };
  return (
    <div className="pwa-pair">
      <div className="pwa-qr">{code ? <div className="phone-qr" role="img" aria-label="Pairing QR code" dangerouslySetInnerHTML={{ __html: code.svg }} /> : <div className="pwa-qr-empty"><QrCode size={40} /><span className="small">The QR code appears here – valid once, for 5 minutes.</span></div>}</div>
      <div className="stack" style={{ gap: 10, minWidth: 0 }}>
        <Field label="Account on the phone" hint="The phone gets exactly the rights of this account – members from Team & roles only see what you share.">
          <select className="select" value={userId} onChange={(e) => { setUserId(e.target.value); setCode(null); }}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.owner ? t('{name} (you, everything)', { name: a.name }) : t('{name} (member)', { name: a.name })}</option>)}</select>
        </Field>
        {l.bases.length > 1 && <Field label="Address for the phone"><Seg value={String(i)} onChange={(v) => { setI(Number(v)); setCode(null); }} options={l.bases.map((b, n) => ({ id: String(n), label: new URL(b).host }))} /></Field>}
        {code ? (
          <>
            <div className="row-tight"><Clock size={14} /><span className="small">{t('Valid for {s} s – scan it with the phone camera.', { s: left })}</span></div>
            <div className="row-tight"><Btn className="sm" icon={Copy} onClick={() => copy(code.url, 'Link copied – send it only to this person')}>Copy link</Btn><Btn className="sm ghost" icon={RefreshCw} onClick={make}>New code</Btn></div>
          </>
        ) : <div><Btn className="primary" icon={QrCode} onClick={make}>Create pairing code</Btn></div>}
        {!l.domain && <div className="tiny muted">Without your own domain the phone browser warns once about the certificate – confirm it, it is Hostwerk's own.</div>}
        <InfoTip title="How pairing works">The code works once and only for 5 minutes. Wrong codes count as failed sign-ins of that address (lockout like for the sign-in). The phone gets its own device key – Hostwerk stores only a fingerprint of it.</InfoTip>
      </div>
    </div>
  );
}

const EVENTS = {
  'code-created': ['Pairing code created', ''], paired: ['Paired with QR code', 'ok'], remembered: ['Phone kept signed in', 'ok'], waiting: ['Waits for approval', 'warn'],
  approved: ['Approved', 'ok'], blocked: ['Blocked', 'err'], all: ['Blocked (all devices)', 'err'], expired: ['Expired (unused too long)', ''], 'signed-out': ['Signed out on the device', ''], 'code-refused': ['Wrong or old pairing code', 'err'],
};

function DeviceRow({ d, reload }) {
  const block = async () => { if (await confirmDialog({ title: t('Block “{name}”?', { name: d.name }), text: 'The device is signed out at once and forgotten. To use it again it has to be paired anew.', confirm: 'Block', danger: true })) { try { await del(`/pwa/devices/${d.id}`); reload(); toast.success('Blocked'); } catch (e) { toast.error(e.message); } } };
  const rename = async () => { const n = await promptDialog({ title: 'Rename device', label: 'Name', value: d.name, confirm: 'Save' }); if (n) { try { await put(`/pwa/devices/${d.id}`, { name: n }); reload(); } catch (e) { toast.error(e.message); } } };
  return (
    <div className={`list-item pwa-device ${d.status}`}>
      <Smartphone size={18} className={d.status === 'pending' ? 'c-warn' : 'muted'} />
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="row-tight"><b className="ellipsis"><Keep>{d.name}</Keep></b>{d.status === 'pending' ? <span className="badge warn">waits for approval</span> : d.orphan ? <span className="badge err">account gone</span> : null}</div>
        <div className="tiny muted ellipsis">{d.user ? <Keep>{d.user}</Keep> : '–'} · <Keep>{d.ua}</Keep> · {t('last seen {when}', { when: fmtDate(d.lastSeen) })}{d.lastIp ? <> · <Keep>{d.lastIp}</Keep></> : null}</div>
      </div>
      {d.status === 'pending' && <Btn className="xs primary" icon={Check} onClick={async () => { try { await post(`/pwa/devices/${d.id}/approve`); reload(); toast.success('Approved'); } catch (e) { toast.error(e.message); } }}>Approve</Btn>}
      <button type="button" className="btn ghost xs icon" title="Rename" aria-label="Rename" onClick={rename}><Pencil /></button>
      <button type="button" className="btn ghost xs icon danger" title="Block" aria-label="Block" onClick={block}><Trash2 /></button>
    </div>
  );
}

/** Go live → Hostwerk app (tab) and the extension's own page */
function AppTab() {
  const v = useApi('/pwa', [], { live: false, poll: true });
  useEffect(() => on('pwa-devices', () => v.reload()), []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!v.data) return <Loading />;
  const d = v.data;
  const pending = d.devices.filter((x) => x.status === 'pending');
  const save = async (patch) => { try { v.setData(await put('/pwa/settings', patch)); } catch (e) { toast.error(e.message); } };
  return (
    <div className="stack">
      {pending.length > 0 && <Callout kind="warn" title={t('{n} device(s) wait for approval', { n: pending.length })}>Only approve devices you know – someone signed in with this account on a new phone.</Callout>}
      <div className="cols">
        <div className="card span-2">
          <div className="card-head"><QrCode size={16} /><h3>Pair a phone</h3></div>
          <div className="card-body"><PairPanel accounts={d.accounts} /></div>
        </div>
        <div className="card">
          <div className="card-head"><Smartphone size={16} /><h3>Paired devices</h3><span className="badge">{d.devices.length}</span>
            {d.devices.length > 1 && <div className="right"><Btn className="xs ghost danger" onClick={async () => { if (await confirmDialog({ title: 'Block every device?', text: 'All paired phones are signed out at once. Normal sign-ins stay.', confirm: 'Block all', danger: true })) { try { v.setData(await del('/pwa/devices')); } catch (e) { toast.error(e.message); } } }}>Block all</Btn></div>}
          </div>
          {d.devices.length === 0 ? <div className="card-body"><Empty icon={Smartphone} title="No paired devices yet" text="Pair a phone with the QR code – or keep it signed in on the phone under “More”." /></div>
            : d.devices.map((x) => <DeviceRow key={x.id} d={x} reload={() => v.reload()} />)}
        </div>
        <div className="card">
          <div className="card-head"><ShieldCheck size={16} /><h3>Security</h3></div>
          <div className="card-body stack" style={{ gap: 10 }}>
            <SettingRow title="Approve your own new devices on the PC" text="A phone you keep signed in after a normal sign-in waits until you approve it here – a stolen password alone is then not enough. Phones of members always wait for your approval (they have no two-factor code)."><Switch checked={d.settings.approveNew} onChange={(x) => save({ approveNew: x })} /></SettingRow>
            <SettingRow title="Report new devices" text="New devices and devices waiting for approval go to your alerts (Go live → Monitoring → alert channels)."><Switch checked={d.settings.alertNew} onChange={(x) => save({ alertNew: x })} /></SettingRow>
            <SettingRow title="Expire unused devices" text="A device that is not used for this long is forgotten on its own.">
              <select className="select" style={{ width: 'auto' }} aria-label="Expire unused devices" value={d.settings.idleDays} onChange={(e) => save({ idleDays: Number(e.target.value) })}>{[7, 14, 30, 60, 90, 180].map((n) => <option key={n} value={n}>{t('{n} days', { n })}</option>)}</select>
            </SettingRow>
            <div className="tiny muted">Sign-in itself stays Hostwerk's: password and two-factor code, passkeys, lockout per address and per account (Go live → Remote access). Rights of members come from Team &amp; roles.</div>
          </div>
        </div>
        <div className="card span-2">
          <div className="card-head"><ShieldAlert size={16} /><h3>Security log</h3><span className="badge">{d.log.length}</span></div>
          {d.log.length === 0 ? <div className="card-body"><TileEmpty icon={ShieldCheck} text="Nothing happened yet." /></div> : d.log.slice(0, 30).map((e) => { const [label, kind] = EVENTS[e.event] || [e.event, '']; return (
            <div key={`${e.t}-${e.event}`} className="list-item pwa-log">
              <span className={`badge ${kind}`}>{label}</span>
              <span className="grow small ellipsis"><Keep>{[e.device, e.user, e.ip, e.ua].filter(Boolean).join(' · ')}</Keep></span>
              <span className="tiny muted">{fmtDate(e.t)}</span>
            </div>
          ); })}
        </div>
      </div>
    </div>
  );
}

/** Button in the remote access card: "Pair phone …" → window with the pairing panel */
function PairButton() {
  const [open, setOpen] = useState(false);
  const v = useApi(open ? '/pwa' : null, [open], { live: false });
  return (
    <>
      <Btn className="sm" icon={Smartphone} onClick={() => setOpen(true)}>Pair phone …</Btn>
      {open && <Modal title="Pair a phone" subtitle="Hostwerk on the phone as an app – devices and security under Go live → Hostwerk app." size="wide" onClose={() => setOpen(false)} footer={<><a className="btn ghost" href="#/live/app" onClick={() => setOpen(false)}>Devices &amp; security</a><Btn onClick={() => setOpen(false)}>Close</Btn></>}>
        {v.data ? <PairPanel accounts={v.data.accounts} /> : <Loading />}
      </Modal>}
    </>
  );
}

export default {
  pages: { main: AppTab },
  screens: { handy: { Component: PhoneApp, mobileHome: true } },
  slots: {
    'live.tabs': [{ id: 'app', title: 'Hostwerk app', icon: Smartphone, Component: AppTab, order: 75 }],
    'live.remote.actions': [{ id: 'pair', title: 'Pair phone', Component: PairButton }],
  },
};
