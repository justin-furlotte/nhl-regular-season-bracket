(() => {
'use strict';

/* =====================================================================
   NHL Standings Predictor
   Sections: rules and data / helpers / backend session / picks screen /
             submit flow / leagues screens / router and startup
   ===================================================================== */

/* ================= League rules ================= */
const GAMES = 84;                                   // games per team in 2026-27
const TEAM_COUNT = 32;
// Total games = GAMES * TEAM_COUNT / 2 (each game has two teams).
// Each game awards 2 points (regulation) or 3 points (OT/shootout).
const MIN_TOTAL = GAMES * TEAM_COUNT;               // 2,688: every game ends in regulation
const MAX_TOTAL = (GAMES * TEAM_COUNT * 3) / 2;     // 4,032: every game goes to overtime
const MAX_TEAM  = GAMES * 2;                        // 168: win every game
const MAX_LEAGUE_PLAYERS = 12;                      // enforced by the database; shown here for display

/* ================= Teams: [code, city, nickname, color] =================
   Keep in sync with the `teams` table in supabase/schema.sql. */
const LEAGUE = [
  { conf: 'Eastern Conference', divisions: [
    { name: 'Atlantic', teams: [
      ['BOS', 'Boston',    'Bruins',        '#FFB81C'],
      ['BUF', 'Buffalo',   'Sabres',        '#003087'],
      ['DET', 'Detroit',   'Red Wings',     '#CE1126'],
      ['FLA', 'Florida',   'Panthers',      '#B9975B'],
      ['MTL', 'Montréal',  'Canadiens',     '#AF1E2D'],
      ['OTT', 'Ottawa',    'Senators',      '#C52032'],
      ['TBL', 'Tampa Bay', 'Lightning',     '#1A56B0'],
      ['TOR', 'Toronto',   'Maple Leafs',   '#00205B'],
    ]},
    { name: 'Metropolitan', teams: [
      ['CAR', 'Carolina',     'Hurricanes',    '#CC0000'],
      ['CBJ', 'Columbus',     'Blue Jackets',  '#002654'],
      ['NJD', 'New Jersey',   'Devils',        '#CE1126'],
      ['NYI', 'New York',     'Islanders',     '#00539B'],
      ['NYR', 'New York',     'Rangers',       '#0038A8'],
      ['PHI', 'Philadelphia', 'Flyers',        '#F74902'],
      ['PIT', 'Pittsburgh',   'Penguins',      '#FCB514'],
      ['WSH', 'Washington',   'Capitals',      '#C8102E'],
    ]},
  ]},
  { conf: 'Western Conference', divisions: [
    { name: 'Central', teams: [
      ['CHI', 'Chicago',   'Blackhawks',  '#CF0A2C'],
      ['COL', 'Colorado',  'Avalanche',   '#6F263D'],
      ['DAL', 'Dallas',    'Stars',       '#006847'],
      ['MIN', 'Minnesota', 'Wild',        '#154734'],
      ['NSH', 'Nashville', 'Predators',   '#FFB81C'],
      ['STL', 'St. Louis', 'Blues',       '#002F87'],
      ['UTA', 'Utah',      'Mammoth',     '#6CACE4'],
      ['WPG', 'Winnipeg',  'Jets',        '#004C97'],
    ]},
    { name: 'Pacific', teams: [
      ['ANA', 'Anaheim',     'Ducks',          '#F47A38'],
      ['CGY', 'Calgary',     'Flames',         '#D2001C'],
      ['EDM', 'Edmonton',    'Oilers',         '#FF4C00'],
      ['LAK', 'Los Angeles', 'Kings',          '#111111'],
      ['SJS', 'San Jose',    'Sharks',         '#006D75'],
      ['SEA', 'Seattle',     'Kraken',         '#99D9D9'],
      ['VAN', 'Vancouver',   'Canucks',        '#00843D'],
      ['VGK', 'Vegas',       'Golden Knights', '#B4975A'],
    ]},
  ]},
];

const DIVISIONS = LEAGUE.flatMap(c => c.divisions);
const TEAMS = {};
for (const d of DIVISIONS) {
  for (const [code, city, nick, color] of d.teams) TEAMS[code] = { code, city, nick, color };
}
const ALL_CODES = Object.keys(TEAMS);

/* --- scoring (start) --- Not used by the UI yet; ready for when results exist. */
function scoreTeam(pred, actual) {
  const pointsScore = Math.max(0, 10 - Math.abs(actual.points - pred.points));
  const positionBonus = pred.position === actual.position ? 10 : 0;
  return pointsScore + positionBonus;
}
// predicted / actual: { BOS: { points: 101, position: 2 }, ... } (position = rank within division)
function scoreEntry(predicted, actual) {
  return Object.keys(actual).reduce((sum, code) => sum + scoreTeam(predicted[code], actual[code]), 0);
}
/* --- scoring (end) --- */

/* ================= Helpers ================= */
const $ = id => document.getElementById(id);
const fmt = n => n.toLocaleString('en-US');
const fmtWhen = iso => new Date(iso).toLocaleString(undefined, {
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
});
const reducedMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Tiny DOM builder. Strings become text nodes, so user-provided text is never parsed as HTML.
function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid);
  return e;
}

function inkOn(hex) {
  const n = parseInt(hex.slice(1), 16);
  const luma = 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return luma > 150 ? '#0F1D2B' : '#FFFFFF';
}
function announce(msg) { $('sr').textContent = msg; }

let toastTimer = null;
function toast(msg, kind) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (kind === 'error' ? ' error' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4500);
}

function avatarEl(name, url, size = 28) {
  const initials = (name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
  const el = h('span', { class: 'avatar', style: `--s:${size}px`, 'aria-hidden': 'true' }, initials);
  if (url) {
    const img = h('img', { src: url, alt: '', referrerpolicy: 'no-referrer' });
    img.addEventListener('error', () => img.remove());
    el.append(img);
  }
  return el;
}

/* ================= Backend session ================= */
const cfg = window.APP_CONFIG || {};
const sb = (cfg.supabaseUrl && cfg.supabaseAnonKey && window.supabase)
  ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      // PKCE keeps OAuth tokens out of the URL hash, which this app uses for routing.
      auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  : null;

let session = null;      // Supabase session, or null when signed out
let season = null;       // { id, games_per_team, picks_close_at }
let submission = null;   // { picks, submitted_at } once this user has submitted

const RETURN_KEY = 'nhl-return-to';

async function signIn() {
  if (!sb) return;
  try { localStorage.setItem(RETURN_KEY, location.hash || '#/picks'); } catch (e) { /* ignore */ }
  const { error } = await sb.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: location.origin + location.pathname },
  });
  if (error) toast(error.message, 'error');
}
async function signOut() {
  if (!sb) return;
  const { error } = await sb.auth.signOut();
  if (error) toast(error.message, 'error');
}
function takeReturnHash() {
  try {
    const v = localStorage.getItem(RETURN_KEY);
    localStorage.removeItem(RETURN_KEY);
    return v && v.startsWith('#/') ? v : null;
  } catch (e) { return null; }
}

async function loadSeason() {
  const { data, error } = await sb.from('seasons')
    .select('id,games_per_team,picks_close_at')
    .order('picks_close_at', { ascending: false }).limit(1).maybeSingle();
  if (error) console.error(error);
  season = data || null;
}
async function loadSubmission() {
  submission = null;
  if (!session || !season) return;
  const { data, error } = await sb.from('submissions')
    .select('picks,submitted_at')
    .eq('user_id', session.user.id).eq('season_id', season.id).maybeSingle();
  if (error) console.error(error);
  submission = data || null;
}

function renderAccount() {
  const a = $('account');
  a.replaceChildren();
  if (!sb) { a.append(h('span', { class: 'muted' }, 'Not connected')); return; }
  if (!session) { a.append(h('button', { type: 'button', class: 'btn small', onclick: signIn }, 'Sign in with Google')); return; }
  const meta = session.user.user_metadata || {};
  const name = meta.full_name || meta.name || session.user.email || 'Player';
  a.append(
    avatarEl(name, meta.avatar_url || meta.picture, 24),
    h('span', { class: 'acct-name' }, name.split(' ')[0]),
    h('button', { type: 'button', class: 'link-btn', onclick: signOut }, 'Sign out'),
  );
}

/* ================= Picks: state ================= */
const STORE_KEY = 'nhl-standings-picks-2026-27';   // local draft, until submitted

function defaultState() {
  const order = {};
  for (const d of DIVISIONS) order[d.name] = d.teams.map(t => t[0]);
  return { order, points: {} };
}
function loadDraft() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    const s = defaultState();
    for (const d of DIVISIONS) {
      const codes = d.teams.map(t => t[0]);
      const o = saved.order && saved.order[d.name];
      if (Array.isArray(o) && o.length === codes.length && codes.every(c => o.includes(c))) s.order[d.name] = o.slice();
    }
    let total = 0;
    for (const code of ALL_CODES) {
      const v = saved.points && saved.points[code];
      if (Number.isInteger(v) && v >= 0 && v <= MAX_TEAM && total + v <= MAX_TOTAL) { s.points[code] = v; total += v; }
    }
    return s;
  } catch (e) { return null; }
}
function saveDraft() {
  if (mode !== 'edit') return;
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* storage unavailable */ }
}

// Submission format: { BOS: { points: 101, position: 2 }, ... }  (position = rank within division)
function picksFromState(s) {
  const out = {};
  for (const d of DIVISIONS) s.order[d.name].forEach((code, i) => { out[code] = { points: s.points[code], position: i + 1 }; });
  return out;
}
function stateFromPicks(picks) {
  const s = defaultState();
  for (const d of DIVISIONS) {
    const codes = d.teams.map(t => t[0]);
    s.order[d.name] = codes.slice().sort((a, b) => picks[a].position - picks[b].position);
    for (const c of codes) s.points[c] = picks[c].points;
  }
  return s;
}

let mode = 'edit';                 // 'edit' | 'locked' (submitted) | 'closed' (deadline passed, nothing submitted)
let state = loadDraft() || defaultState();
let routeState = { name: 'picks' };

function computeMode() {
  if (submission) return 'locked';
  if (season && Date.now() >= Date.parse(season.picks_close_at)) return 'closed';
  return 'edit';
}
function getTotal() {
  let t = 0;
  for (const code of ALL_CODES) t += state.points[code] || 0;
  return t;
}

/* ================= Picks: screen ================= */
const lists = {};      // division name -> <ol>
const divTotals = {};  // division name -> <b>
let sortables = [];
let flashMsg = null, flashTimer = null;

function flash(msg) {
  flashMsg = msg;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { flashMsg = null; refresh(); }, 2800);
  announce(msg);
}

const GRIP = '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" fill="currentColor"><circle cx="7" cy="5" r="1.6"/><circle cx="13" cy="5" r="1.6"/><circle cx="7" cy="10" r="1.6"/><circle cx="13" cy="10" r="1.6"/><circle cx="7" cy="15" r="1.6"/><circle cx="13" cy="15" r="1.6"/></svg>';
const WARN = '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M10 2.6 18.4 17H1.6z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M10 8v4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="10" cy="14.4" r="1" fill="currentColor"/></svg>';

// Rebuild the standings from `state` for the current `mode`.
function applyMode() {
  mode = computeMode();
  state = mode === 'locked' ? stateFromPicks(submission.picks) : (loadDraft() || defaultState());
  $('view-picks').classList.toggle('is-readonly', mode !== 'edit');
  $('intro').hidden = mode !== 'edit';
  document.querySelector('.foot').hidden = mode !== 'edit';
  renderStandings();
  renderBanner();
}

function renderStandings() {
  sortables.forEach(s => s.destroy());
  sortables = [];
  const root = $('standings');
  root.replaceChildren();
  for (const conf of LEAGUE) {
    const grid = h('div', { class: 'divs' }, conf.divisions.map(buildDivision));
    root.append(h('section', { class: 'conf' }, h('h2', {}, conf.conf), grid));
  }
  refresh();
}

function buildDivision(div) {
  const card = h('article', { class: 'card' },
    h('div', { class: 'card-h' }, h('h3', {}, div.name), h('span', { class: 'card-total' }, 'Total ', h('b', {}, '0'))));
  divTotals[div.name] = card.querySelector('b');

  const ol = h('ol', { class: 'list', 'aria-label': `${div.name} division, in predicted order` },
    state.order[div.name].map(buildRow));
  card.append(ol);
  lists[div.name] = ol;

  if (window.Sortable && mode === 'edit') {
    sortables.push(Sortable.create(ol, {
      handle: '.grip',
      animation: reducedMotion ? 0 : 160,
      ghostClass: 'is-ghost',
      chosenClass: 'is-chosen',
      dragClass: 'is-drag',
      onEnd: evt => commitOrder(div.name, evt.item),
    }));
  }
  return card;
}

function buildRow(code) {
  const t = TEAMS[code];
  const name = `${t.city} ${t.nick}`;
  const li = document.createElement('li');
  li.className = 'row';
  li.dataset.code = code;
  // Team data above is static and trusted, so building this row from a string is safe.
  li.innerHTML = `
    <button type="button" class="grip" aria-label="Reorder ${name}. Drag, or use the up and down arrow keys.">${GRIP}</button>
    <span class="rank" aria-hidden="true"></span>
    <span class="badge" style="--c:${t.color};--f:${inkOn(t.color)}" aria-hidden="true">${t.code}</span>
    <span class="name"><span class="city">${t.city}</span><span class="nick">${t.nick}</span></span>
    <span class="flag" role="img" aria-label="More points than a team ranked above" title="More points than a team ranked above it">${WARN}</span>
    <label class="pts">
      <input type="text" inputmode="numeric" autocomplete="off" maxlength="3" placeholder="–" aria-label="Predicted points for ${name}">
      <span>pts</span>
    </label>`;

  const input = li.querySelector('input');
  input.value = state.points[code] != null ? String(state.points[code]) : '';
  const locked = mode !== 'edit';
  input.readOnly = locked;
  const grip = li.querySelector('.grip');
  if (locked) { grip.tabIndex = -1; return li; }

  input.addEventListener('focus', () => input.select());
  input.addEventListener('input', () => {
    const digits = input.value.replace(/\D/g, '');
    setPoints(code, digits === '' ? null : parseInt(digits, 10), input);
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const cur = state.points[code] || 0;
      setPoints(code, Math.max(0, cur + (e.key === 'ArrowUp' ? 1 : -1)), input);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const all = [...document.querySelectorAll('.pts input')];
      const next = all[all.indexOf(input) + 1];
      if (next) next.focus(); else input.blur();
    }
  });

  grip.addEventListener('keydown', e => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const ol = li.parentNode;
    if (e.key === 'ArrowUp' && li.previousElementSibling) ol.insertBefore(li, li.previousElementSibling);
    else if (e.key === 'ArrowDown' && li.nextElementSibling) ol.insertBefore(li.nextElementSibling, li);
    else return;
    grip.focus();
    commitOrder(DIVISIONS.find(d => d.teams.some(x => x[0] === code)).name, li);
  });
  return li;
}

function commitOrder(divName, li) {
  if (mode !== 'edit') return;
  state.order[divName] = [...lists[divName].children].map(n => n.dataset.code);
  refresh();
  saveDraft();
  const t = TEAMS[li.dataset.code];
  announce(`${t.city} ${t.nick} is now number ${state.order[divName].indexOf(li.dataset.code) + 1} of ${state.order[divName].length} in the ${divName}`);
}

function setPoints(code, v, input) {
  if (mode !== 'edit') return;
  if (v !== null) {
    if (v > MAX_TEAM) { v = MAX_TEAM; flash(`A team can earn at most ${MAX_TEAM} points in ${GAMES} games`); }
    const others = getTotal() - (state.points[code] || 0);
    const room = Math.max(0, MAX_TOTAL - others);
    if (v > room) { v = room; flash(`League total can't go above ${fmt(MAX_TOTAL)}`); }
  }
  state.points[code] = v;
  const s = v === null ? '' : String(v);
  if (input.value !== s) input.value = s;
  refresh();
  saveDraft();
}

function refresh() {
  const total = getTotal();

  // Counter
  $('totalNum').textContent = fmt(total);
  $('fill').style.width = (total / MAX_TOTAL * 100) + '%';
  $('zone').style.left = (MIN_TOTAL / MAX_TOTAL * 100) + '%';
  const counter = $('counter');
  counter.classList.toggle('is-ok', total >= MIN_TOTAL);
  counter.classList.toggle('is-flash', !!flashMsg);
  let note;
  if (flashMsg) note = flashMsg;
  else if (total < MIN_TOTAL) note = `${fmt(MIN_TOTAL - total)} short of the ${fmt(MIN_TOTAL)} minimum`;
  else if (total >= MAX_TOTAL) note = `At the ${fmt(MAX_TOTAL)} maximum`;
  else note = `Valid total (${fmt(MIN_TOTAL)} to ${fmt(MAX_TOTAL)})`;
  $('counterNote').textContent = note;

  // Ranks, order warnings, division totals
  for (const d of DIVISIONS) {
    let sub = 0;
    let lowestAbove = Infinity;
    [...lists[d.name].children].forEach((li, i) => {
      li.querySelector('.rank').textContent = i + 1;
      const v = state.points[li.dataset.code];
      li.classList.toggle('is-off', v != null && v > lowestAbove);
      if (v != null) { sub += v; lowestAbove = Math.min(lowestAbove, v); }
    });
    divTotals[d.name].textContent = fmt(sub);
  }
  updateSubmitBar();
}

function renderBanner() {
  const b = $('banner');
  b.className = 'banner';
  let msg;
  if (!sb) {
    b.classList.add('warn');
    msg = 'The server connection isn\'t set up yet, so you can practice here but not submit. Add your Supabase settings to config.js.';
  } else if (mode === 'locked') {
    b.classList.add('ok');
    msg = `Submitted ${fmtWhen(submission.submitted_at)}. Your picks are locked until the season ends.`;
  } else if (mode === 'closed') {
    b.classList.add('warn');
    msg = `Picks closed ${fmtWhen(season.picks_close_at)}.${session ? ' You didn\'t submit in time.' : ''}`;
  } else if (!session) {
    msg = `Sign in with Google to submit. Until then your picks are saved in this browser.${season ? ` Picks close ${fmtWhen(season.picks_close_at)}.` : ''}`;
  } else {
    msg = `Picks close ${season ? fmtWhen(season.picks_close_at) : 'when the season starts'}. When you submit, your picks lock for the season.`;
  }
  b.textContent = msg;
  b.hidden = false;
}

/* ---- Reset (draft only) ---- */
let armed = false, armTimer = null;
const resetBtn = $('resetBtn');
function disarm() { armed = false; resetBtn.textContent = 'Clear all picks'; }
resetBtn.addEventListener('click', () => {
  if (mode !== 'edit') return;
  if (!armed) {
    armed = true;
    resetBtn.textContent = 'Click again to clear all picks';
    armTimer = setTimeout(disarm, 3000);
    return;
  }
  clearTimeout(armTimer);
  disarm();
  state = defaultState();
  saveDraft();
  renderStandings();
  announce('All picks cleared');
});

/* ================= Submit flow ================= */
let submitting = false;

function readiness() {
  const total = getTotal();
  const missing = ALL_CODES.filter(c => state.points[c] == null).length;
  if (missing) return { ok: false, msg: `${missing} ${missing === 1 ? 'team still needs' : 'teams still need'} points` };
  if (total < MIN_TOTAL) return { ok: false, msg: `${fmt(MIN_TOTAL - total)} more points needed to reach ${fmt(MIN_TOTAL)}` };
  return { ok: true, msg: 'Ready to submit. Your picks lock once you do.' };
}

function updateSubmitBar() {
  const show = !!sb && routeState.name === 'picks' && mode === 'edit';
  $('submitBar').hidden = !show;
  document.body.classList.toggle('has-bar', show);
  if (!show) return;
  const r = readiness();
  const status = $('submitStatus');
  status.textContent = r.msg;
  status.classList.toggle('is-ready', r.ok);
  const btn = $('submitBtn');
  if (!session) { btn.textContent = 'Sign in to submit'; btn.disabled = false; }
  else { btn.textContent = submitting ? 'Submitting…' : 'Submit picks'; btn.disabled = !r.ok || submitting; }
}

function confirmSubmit() {
  return new Promise(resolve => {
    const dlg = $('confirmDlg');
    dlg.returnValue = '';
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'confirm'), { once: true });
    dlg.showModal();
  });
}

async function onSubmitClick() {
  if (!session) return signIn();
  if (submitting || mode !== 'edit' || !readiness().ok) return;
  if (!(await confirmSubmit())) return;

  submitting = true;
  updateSubmitBar();
  const { error } = await sb.rpc('submit_picks', { p_picks: picksFromState(state) });
  submitting = false;

  if (error) {
    toast(error.message, 'error');
    await loadSubmission();          // e.g. already submitted from another device, or picks closed
    applyMode();
    return;
  }
  try { localStorage.removeItem(STORE_KEY); } catch (e) { /* ignore */ }
  await loadSubmission();
  applyMode();
  window.scrollTo({ top: 0 });
  toast('Picks submitted and locked. Good luck!');
}
$('submitBtn').addEventListener('click', onSubmitClick);

/* ================= Leagues screens ================= */
function signInCard(text) {
  return h('div', { class: 'empty' },
    h('p', { style: 'margin:0 0 12px' }, text),
    h('button', { type: 'button', class: 'btn primary', onclick: signIn }, 'Sign in with Google'));
}
const offlineCard = () => h('div', { class: 'empty' }, 'The server connection isn\'t set up yet. Add your Supabase settings to config.js (see the README).');

function formPanel({ title, label, placeholder, button, maxlength, upper, onSubmit }) {
  const input = h('input', { type: 'text', placeholder, maxlength, autocomplete: 'off', required: true });
  if (upper) input.addEventListener('input', () => { input.value = input.value.toUpperCase(); });
  const btn = h('button', { class: 'btn primary', type: 'submit' }, button);
  return h('form', {
    class: 'card panel',
    onsubmit: async e => {
      e.preventDefault();
      btn.disabled = true;
      try { await onSubmit(input.value.trim()); } finally { btn.disabled = false; }
    },
  }, h('h3', {}, title), h('label', { class: 'field' }, h('span', {}, label), input), btn);
}

async function showLeagues(token) {
  const v = $('view-leagues');
  if (!sb) return v.replaceChildren(offlineCard());
  if (!session) return v.replaceChildren(h('h2', { class: 'page-h' }, 'Leagues'),
    signInCard('Sign in with Google to create a league or join one with an invite code.'));

  v.replaceChildren(h('h2', { class: 'page-h' }, 'Your leagues'), h('p', { class: 'muted' }, 'Loading…'));
  const { data, error } = await sb.from('leagues')
    .select('id,name,league_members(count)').order('created_at', { ascending: false });
  if (token !== navToken) return;

  const list = error
    ? h('div', { class: 'empty' }, `Couldn't load your leagues: ${error.message}`)
    : !data.length
      ? h('div', { class: 'empty' }, 'You\'re not in any leagues yet. Create one below, or join with an invite code.')
      : h('div', { class: 'stack' }, data.map(l => {
          const n = l.league_members?.[0]?.count ?? 0;
          return h('a', { class: 'league-card', href: `#/league/${l.id}` },
            h('span', { class: 'league-name' }, l.name),
            h('span', { class: 'muted small' }, `${n} of ${MAX_LEAGUE_PLAYERS} players`));
        }));

  const create = formPanel({
    title: 'Create a league', label: 'League name', placeholder: 'Office pool', button: 'Create league', maxlength: 60,
    onSubmit: async name => {
      const { data: id, error: err } = await sb.rpc('create_league', { p_name: name });
      if (err) return toast(err.message, 'error');
      location.hash = `#/league/${id}`;
    },
  });
  const join = formPanel({
    title: 'Join a league', label: 'Invite code', placeholder: 'A1B2C3D4', button: 'Join league', maxlength: 200,
    onSubmit: async raw => {
      const code = raw.includes('/join/') ? decodeURIComponent(raw.split('/join/').pop()) : raw;
      const { data: id, error: err } = await sb.rpc('join_league', { p_code: code });
      if (err) return toast(err.message, 'error');
      location.hash = `#/league/${id}`;
    },
  });

  v.replaceChildren(h('h2', { class: 'page-h' }, 'Your leagues'), list, h('div', { class: 'panels' }, create, join));
}

async function copyText(text, okMsg) {
  try { await navigator.clipboard.writeText(text); toast(okMsg); }
  catch (e) { toast('Couldn\'t copy automatically. Select the text and copy it.', 'error'); }
}

async function showLeague(token, id) {
  const v = $('view-league');
  const back = h('a', { class: 'back', href: '#/leagues' }, '‹ Your leagues');
  if (!sb) return v.replaceChildren(offlineCard());
  if (!session) return v.replaceChildren(signInCard('Sign in with Google to see this league.'));
  const notFound = () => v.replaceChildren(back, h('div', { class: 'empty' }, 'League not found. It may not exist, or you may not be a member yet.'));
  if (!UUID_RE.test(id)) return notFound();

  v.replaceChildren(back, h('p', { class: 'muted' }, 'Loading…'));
  const [lg, ov] = await Promise.all([
    sb.from('leagues').select('id,name,invite_code,owner_id').eq('id', id).maybeSingle(),
    sb.rpc('league_overview', { p_league: id }),
  ]);
  if (token !== navToken) return;
  if (lg.error || !lg.data) return notFound();
  if (ov.error) return v.replaceChildren(back, h('div', { class: 'empty' }, `Couldn't load members: ${ov.error.message}`));

  const league = lg.data;
  const members = ov.data || [];
  const inviteUrl = `${location.origin}${location.pathname}#/join/${league.invite_code}`;
  const open = season && Date.now() < Date.parse(season.picks_close_at);

  v.replaceChildren(
    back,
    h('h2', { class: 'page-h' }, league.name),
    h('p', { class: 'muted', style: 'margin:0' }, `${members.length} of ${MAX_LEAGUE_PLAYERS} players`),
    h('div', { class: 'invite' },
      h('span', { class: 'muted small' }, 'Invite code'),
      h('span', { class: 'code' }, league.invite_code),
      h('button', { type: 'button', class: 'btn small', onclick: () => copyText(inviteUrl, 'Invite link copied') }, 'Copy invite link')),
    h('h3', { class: 'section-h' }, 'Players'),
    h('div', { class: 'members' }, members.map(m => h('div', { class: 'member' },
      avatarEl(m.display_name, m.avatar_url, 32),
      h('span', { class: 'member-name' }, m.display_name,
        m.member_id === session.user.id ? h('span', { class: 'tag' }, 'you') : null,
        m.is_owner ? h('span', { class: 'tag' }, 'owner') : null),
      h('span', { class: m.has_submitted ? 'pill ok' : 'pill' }, m.has_submitted ? 'Submitted' : 'Not submitted yet')))),
    h('p', { class: 'muted small', style: 'margin-top:12px' },
      open ? `Everyone's picks stay hidden until picks close ${fmtWhen(season.picks_close_at)}.` : 'Picks are closed.'),
  );
}

async function showJoin(token, code) {
  const v = $('view-join');
  if (!sb) return v.replaceChildren(offlineCard());
  if (!session) return v.replaceChildren(h('h2', { class: 'page-h' }, 'You\'re invited to a league'),
    signInCard('Sign in with Google to join.'));

  v.replaceChildren(h('p', { class: 'muted' }, 'Joining league…'));
  const { data: id, error } = await sb.rpc('join_league', { p_code: code });
  if (token !== navToken) return;
  if (error) {
    return v.replaceChildren(h('h2', { class: 'page-h' }, 'Couldn\'t join that league'),
      h('p', {}, error.message),
      h('a', { class: 'btn', href: '#/leagues' }, 'Go to your leagues'));
  }
  location.replace(`${location.pathname}${location.search}#/league/${id}`);
}

/* ================= Router and startup ================= */
let navToken = 0;

function parseHash() {
  const [a, b] = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (a === 'leagues') return { name: 'leagues' };
  if (a === 'league' && b) return { name: 'league', id: b };
  if (a === 'join' && b) return { name: 'join', code: decodeURIComponent(b) };
  return { name: 'picks' };
}

async function route() {
  const token = ++navToken;
  routeState = parseHash();
  const name = routeState.name;
  $('loading').hidden = true;
  for (const v of ['picks', 'leagues', 'league', 'join']) $('view-' + v).hidden = v !== name;
  const navKey = name === 'league' || name === 'join' ? 'leagues' : name;
  document.querySelectorAll('[data-nav]').forEach(a => {
    if (a.dataset.nav === navKey) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  $('counter').hidden = name !== 'picks';
  updateSubmitBar();
  if (name === 'leagues') await showLeagues(token);
  else if (name === 'league') await showLeague(token, routeState.id);
  else if (name === 'join') await showJoin(token, routeState.code);
}
window.addEventListener('hashchange', route);

// Runs when the signed-in user changes after startup (sign out, or sign in from another tab).
async function onSessionChange(next) {
  const before = session && session.user.id;
  session = next;
  if ((next && next.user.id) === before) return;   // token refresh, not a real change
  if (session) await loadSubmission(); else submission = null;
  renderAccount();
  applyMode();
  route();
}

async function start() {
  if (sb) {
    try {
      const { data } = await sb.auth.getSession();   // also completes the Google sign-in redirect
      session = data.session;
      await loadSeason();
      if (session) await loadSubmission();
    } catch (e) { console.error(e); }
    sb.auth.onAuthStateChange((_event, next) => setTimeout(() => onSessionChange(next), 0));
  }
  renderAccount();
  applyMode();

  // Back to where the person was before the Google redirect (e.g. an invite link).
  const back = session && takeReturnHash();
  if (back) history.replaceState(null, '', location.pathname + location.search + back);
  route();
}
start();
})();
