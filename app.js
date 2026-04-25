// DNBingo client – v2.
// Real-time 3x3 music bingo on top of Firestore.
// Pool tracks come from iTunes Search (primary) and MusicBrainz (fallback);
// players sign in anonymously (Auth UID = playerId), admin uses email/password.

const ADMIN_UID         = 'bNAAXb9LreTJjuKQLjRBlLOUH2X2';
const HOST_HEARTBEAT_MS = 10_000;   // host touches hostLastSeen every 10s
const HOST_GRACE_MS     = 30_000;   // >30s without heartbeat → "disconnected"
const SEARCH_DEBOUNCE   = 400;
const SEARCH_LIMIT      = 8;

// Winning lines on a 3x3 grid (cell indices).
const LINES = [
  [0,1,2],[3,4,5],[6,7,8],
  [0,3,6],[1,4,7],[2,5,8],
  [0,4,8],[2,4,6]
];

const COLORS = ['#ff2e7a','#00e5ff','#c5ff00','#ff8c00','#7c4dff','#3dba6f','#e040fb'];

const auth = firebase.auth();
const db   = firebase.firestore();
auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(() => {});

// State
let gameId        = null;
let playerId      = null;   // = Firebase Auth UID
let playerName    = null;
let isHost        = false;
let isAdmin       = false;
let currentGame   = null;
let cardSelection = new Set();
let prevWinner    = null;
let unsubGame     = null;
let unsubAdmin    = null;

// Host heartbeat + grace-period UI ticker
let hostBeatTimer = null;
let graceTicker   = null;

// Search request race guard
let searchSeq     = 0;

// Shorthands
const $ = id => document.getElementById(id);
const gameDoc = () => db.collection('games').doc(gameId);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateCode() {
  // CSPRNG – game codes must not be predictable.
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const buf   = new Uint32Array(6);
  crypto.getRandomValues(buf);
  let out = '';
  for (const n of buf) out += chars[n % chars.length];
  return out;
}

function playerColor(id) {
  let h = 0;
  for (const c of id) h = (h + c.charCodeAt(0)) % COLORS.length;
  return COLORS[h];
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
}

function toast(msg, ms = 3000) {
  document.querySelector('.toast')?.remove();
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

function formatDate(ts) {
  if (!ts) return '—';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleString();
}

function formatAge(ts) {
  if (!ts) return '—';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  const mins = Math.floor((Date.now() - d.getTime()) / 60000);
  if (mins < 1)   return 'just now';
  if (mins < 60)  return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function initialsOf(title, artist) {
  const s = (artist || title || '??').trim();
  const parts = s.split(/\s+/).slice(0, 2);
  return parts.map(p => p[0]?.toUpperCase() || '').join('') || '??';
}

function coverPlaceholder(track) {
  // Deterministic colored tile for tracks without artwork.
  const seed = (track.id || track.title || 'x');
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const hue = h % 360;
  return `linear-gradient(135deg, hsl(${hue} 70% 22%), hsl(${(hue + 40) % 360} 70% 12%))`;
}

// Whitelist cover URLs: http(s) only and no characters that could break out
// of the CSS url() context (quotes, parens, angle brackets, whitespace).
// Anything else falls back to the gradient placeholder.
function safeCoverUrl(url) {
  if (typeof url !== 'string' || url.length > 2048) return null;
  return /^https?:\/\/[^'"<>\s)]+$/.test(url) ? url : null;
}

function coverStyle(track) {
  const url = safeCoverUrl(track.cover);
  if (url) return `background-image:url('${url}')`;
  return `background:${coverPlaceholder(track)}`;
}

// Copy-to-clipboard with iOS/Safari fallback.
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity  = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch { return false; }
  }
}

// ---------------------------------------------------------------------------
// Bingo logic
// ---------------------------------------------------------------------------

function checkBingo(card, markedSet) {
  if (!card || card.length !== 9) return null;
  for (const line of LINES) {
    if (line.every(i => markedSet.has(card[i]))) return line;
  }
  return null;
}

function maxLineProgress(card, markedSet) {
  if (!card || card.length !== 9) return 0;
  return Math.max(...LINES.map(line => line.filter(i => markedSet.has(card[i])).length));
}

// ---------------------------------------------------------------------------
// Search – iTunes primary, MusicBrainz fallback
// ---------------------------------------------------------------------------

async function searchITunes(query) {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}`
            + `&media=music&entity=song&limit=${SEARCH_LIMIT}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('iTunes ' + r.status);
  const data = await r.json();
  return (data.results || []).map(t => ({
    id:     `it:${t.trackId}`,
    title:  t.trackName,
    artist: t.artistName,
    album:  t.collectionName || '',
    cover:  t.artworkUrl100 ? t.artworkUrl100.replace('100x100bb', '300x300bb') : null,
    source: 'itunes'
  }));
}

async function searchMusicBrainz(query) {
  const url = `https://musicbrainz.org/ws/2/recording/?query=${encodeURIComponent(query)}`
            + `&limit=${SEARCH_LIMIT}&fmt=json`;
  const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!r.ok) throw new Error('MusicBrainz ' + r.status);
  const data = await r.json();
  return (data.recordings || []).map(rec => {
    const releaseId = rec.releases?.[0]?.id || null;
    return {
      id:     `mb:${rec.id}`,
      title:  rec.title,
      artist: rec['artist-credit']?.[0]?.name || '—',
      album:  rec.releases?.[0]?.title || '',
      cover:  releaseId ? `https://coverartarchive.org/release/${releaseId}/front-250` : null,
      source: 'musicbrainz'
    };
  });
}

async function searchTracks(query) {
  try {
    const primary = await searchITunes(query);
    if (primary.length) return primary;
  } catch { /* fall through to MB */ }
  try {
    return await searchMusicBrainz(query);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

async function ensureAnonymousAuth() {
  const u = auth.currentUser;
  if (u && u.isAnonymous) { playerId = u.uid; return; }
  if (u && !u.isAnonymous) await auth.signOut();
  const cred = await auth.signInAnonymously();
  playerId = cred.user.uid;
}

function authStateReady() {
  return new Promise(resolve => {
    const off = auth.onAuthStateChanged(u => { off(); resolve(u); });
  });
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', async () => {
  $('btn-mode-create').addEventListener('click', () => setWelcomeMode('create'));
  $('btn-mode-join').addEventListener('click',   () => setWelcomeMode('join'));
  document.querySelectorAll('.back-link[data-back="chooser"]').forEach(b =>
    b.addEventListener('click', () => setWelcomeMode('chooser'))
  );

  $('btn-create').addEventListener('click', createGame);
  $('btn-join').addEventListener('click', joinGame);
  $('input-name-create').addEventListener('keydown', e => e.key === 'Enter' && createGame());
  $('input-name-join').addEventListener('keydown',   e => e.key === 'Enter' && joinGame());
  $('input-code').addEventListener('keydown',        e => e.key === 'Enter' && joinGame());

  $('btn-copy').addEventListener('click', async () => {
    const ok = await copyText(gameId);
    toast(ok ? 'Code copied!' : 'Copy failed – select manually.');
  });

  // Search box in lobby
  const searchInput = $('input-search');
  searchInput.addEventListener('input', debounce(onSearchInput, SEARCH_DEBOUNCE));
  searchInput.addEventListener('focus', () => {
    if (searchInput.value.trim()) onSearchInput();
  });
  document.addEventListener('click', e => {
    if (!e.target.closest('.search-box')) hideSearchResults();
  });

  $('btn-start').addEventListener('click', startGame);
  $('btn-leave-lobby').addEventListener('click', leaveGame);

  $('list-pool').addEventListener('click', e => {
    const btn = e.target.closest('.btn-remove');
    if (btn) removeTrack(btn.dataset.id);
  });
  $('list-players').addEventListener('click', e => {
    const btn = e.target.closest('.btn-kick');
    if (btn) kickPlayer(btn.dataset.pid);
  });

  $('btn-confirm').addEventListener('click', confirmCard);
  $('btn-new-game').addEventListener('click', newGame);
  $('btn-end-game').addEventListener('click', endGameHost);
  $('btn-close-banner').addEventListener('click', () => $('win-banner').classList.add('hidden'));

  // Played bottom sheet
  $('btn-open-played').addEventListener('click', openPlayedSheet);
  $('btn-close-played').addEventListener('click', closePlayedSheet);
  $('played-backdrop').addEventListener('click', closePlayedSheet);
  $('input-played-filter').addEventListener('input', renderPlayedSheet);

  $('btn-admin-login').addEventListener('click', adminLogin);
  $('input-admin-pass').addEventListener('keydown', e => e.key === 'Enter' && adminLogin());
  $('btn-admin-logout').addEventListener('click', adminLogout);
  $('link-admin-back').addEventListener('click', e => {
    e.preventDefault();
    location.hash = '';
  });

  window.addEventListener('hashchange', route);
  window.addEventListener('online',  () => $('connection-banner').classList.add('hidden'));
  window.addEventListener('offline', () => {
    $('connection-banner').textContent = 'You are offline. Changes will sync when reconnected.';
    $('connection-banner').classList.remove('hidden');
  });

  await authStateReady();
  await route();
});

// #admin → admin flow, anything else → normal game flow.
async function route() {
  if (location.hash === '#admin') {
    await enterAdminFlow();
    return;
  }

  if (unsubAdmin) { unsubAdmin(); unsubAdmin = null; }
  if (isAdmin) {
    isAdmin = false;
    if (auth.currentUser && !auth.currentUser.isAnonymous) await auth.signOut();
  }

  await ensureAnonymousAuth();
  await tryReconnect();
}

function setWelcomeMode(mode) {
  $('welcome-chooser').classList.toggle('hidden', mode !== 'chooser');
  $('welcome-create').classList.toggle('hidden',  mode !== 'create');
  $('welcome-join').classList.toggle('hidden',    mode !== 'join');
  if (mode === 'create') $('input-name-create').focus();
  if (mode === 'join')   $('input-name-join').focus();
}

async function tryReconnect() {
  showScreen('screen-welcome');
  setWelcomeMode('chooser');

  const savedId   = localStorage.getItem('bingo_gid');
  const savedName = localStorage.getItem('bingo_name');
  if (!savedId || !savedName) return;

  try {
    // Force server read – never trust the Firestore offline cache here,
    // otherwise a deleted game still reconnects from stale data.
    const snap = await db.collection('games').doc(savedId).get({ source: 'server' });
    if (!snap.exists || !snap.data().players?.[playerId]) {
      clearSave();
      return;
    }
    gameId     = savedId;
    playerName = savedName;
    isHost     = snap.data().hostId === playerId;
    if (isHost) startHostHeartbeat();
    listenToGame();
  } catch {
    // Offline or rules reject – stay on welcome, don't drop the save yet.
  }
}

function clearSave() {
  localStorage.removeItem('bingo_gid');
  localStorage.removeItem('bingo_name');
}

// ---------------------------------------------------------------------------
// Create / join / leave
// ---------------------------------------------------------------------------

async function createGame() {
  const name = $('input-name-create').value.trim();
  if (!name) { toast('Please enter your name!'); return; }

  await ensureAnonymousAuth();

  // If we're still listed as host on a previous game, replace it rather
  // than stacking. We can't list the whole collection (admin-only), so we
  // trust localStorage as the only anchor to our last session.
  const priorId = localStorage.getItem('bingo_gid');
  if (priorId) {
    try {
      const prior = await db.collection('games').doc(priorId).get({ source: 'server' });
      if (prior.exists && prior.data().hostId === playerId) {
        await db.collection('games').doc(priorId).delete();
      }
    } catch { /* ignore – worst case admin cleans up later */ }
  }

  playerName = name;
  isHost     = true;

  // Retry on the unlikely code collision (32^6 keyspace).
  let created = false;
  for (let attempt = 0; attempt < 5 && !created; attempt++) {
    const candidate = generateCode();
    try {
      await db.collection('games').doc(candidate).set({
        hostId:       playerId,
        status:       'lobby',
        version:      2,
        pool:         [],
        markedIds:    [],
        players:      { [playerId]: { name, card: null, hasWon: false } },
        winner:       null,
        winnerName:   null,
        hostLastSeen: firebase.firestore.FieldValue.serverTimestamp(),
        createdAt:    firebase.firestore.FieldValue.serverTimestamp()
      });
      gameId = candidate;
      created = true;
    } catch {
      // Code collision or rules reject – try again with a new code.
    }
  }

  if (!created) { toast('Failed to create game.'); return; }

  localStorage.setItem('bingo_gid',  gameId);
  localStorage.setItem('bingo_name', name);

  startHostHeartbeat();
  listenToGame();
}

async function joinGame() {
  const rawName = $('input-name-join').value.trim();
  const code    = $('input-code').value.trim().toUpperCase();
  if (!rawName) { toast('Please enter your name!'); return; }
  if (!code)    { toast('Please enter game code!'); return; }

  await ensureAnonymousAuth();

  let snap;
  try { snap = await db.collection('games').doc(code).get({ source: 'server' }); }
  catch { toast('Connection error.'); return; }

  if (!snap.exists)                   { toast('Game not found.'); return; }
  if (snap.data().status !== 'lobby') { toast('Game already started or finished.'); return; }

  // Avoid name collisions by appending (2), (3)…
  const existingNames = new Set(
    Object.entries(snap.data().players || {})
      .filter(([pid]) => pid !== playerId)
      .map(([, p]) => p.name)
  );
  let name = rawName;
  let i = 2;
  while (existingNames.has(name)) name = `${rawName} (${i++})`;

  playerName = name;
  gameId     = code;
  isHost     = snap.data().hostId === playerId;

  localStorage.setItem('bingo_gid',  gameId);
  localStorage.setItem('bingo_name', name);

  await gameDoc().update({
    [`players.${playerId}`]: { name, card: null, hasWon: false }
  });

  if (isHost) startHostHeartbeat();
  listenToGame();
}

async function leaveGame() {
  if (!gameId) { newGame(); return; }
  const id = gameId;
  stopHostHeartbeat();
  if (unsubGame) { unsubGame(); unsubGame = null; }

  // Even the host only removes themselves as a player – the game lives on
  // until End Game, admin termination, or the session is otherwise cleaned up.
  try {
    await db.collection('games').doc(id).update({
      [`players.${playerId}`]: firebase.firestore.FieldValue.delete()
    });
  } catch {}

  newGame();
}

async function endGameHost() {
  if (!gameId || !isHost) return;
  if (!confirm('End the game for everyone?')) return;
  const id = gameId;
  stopHostHeartbeat();
  if (unsubGame) { unsubGame(); unsubGame = null; }
  try { await db.collection('games').doc(id).delete(); } catch {}
  newGame();
}

// ---------------------------------------------------------------------------
// Host heartbeat
// ---------------------------------------------------------------------------

function startHostHeartbeat() {
  stopHostHeartbeat();
  const beat = () => {
    if (!gameId || !isHost) return;
    gameDoc().update({
      hostLastSeen: firebase.firestore.FieldValue.serverTimestamp()
    }).catch(() => {});
  };
  beat();
  hostBeatTimer = setInterval(beat, HOST_HEARTBEAT_MS);
}

function stopHostHeartbeat() {
  if (hostBeatTimer) { clearInterval(hostBeatTimer); hostBeatTimer = null; }
}

function updateGraceBanner() {
  if (!currentGame || isHost) {
    $('host-grace-banner').classList.add('hidden');
    return;
  }
  const seen = currentGame.hostLastSeen?.toMillis?.();
  if (!seen) { $('host-grace-banner').classList.add('hidden'); return; }
  const age = Date.now() - seen;
  if (age > HOST_GRACE_MS) {
    const sec = Math.floor(age / 1000);
    $('host-grace-banner').textContent =
      `Host hasn't pinged in ${sec}s – they may have disconnected.`;
    $('host-grace-banner').classList.remove('hidden');
  } else {
    $('host-grace-banner').classList.add('hidden');
  }
}

function startGraceTicker() {
  if (graceTicker) return;
  graceTicker = setInterval(updateGraceBanner, 5000);
}

function stopGraceTicker() {
  if (graceTicker) { clearInterval(graceTicker); graceTicker = null; }
  $('host-grace-banner').classList.add('hidden');
}

// ---------------------------------------------------------------------------
// Search UI
// ---------------------------------------------------------------------------

async function onSearchInput() {
  const q = $('input-search').value.trim();
  const resultsEl = $('search-results');
  if (!q) { hideSearchResults(); return; }

  const mySeq = ++searchSeq;
  resultsEl.innerHTML = '<div class="search-empty">Searching…</div>';
  resultsEl.classList.remove('hidden');

  const results = await searchTracks(q);
  if (mySeq !== searchSeq) return;  // a newer query superseded this one

  renderSearchResults(results, q);
}

function renderSearchResults(results, query) {
  const resultsEl = $('search-results');
  const existing  = new Set((currentGame?.pool || []).map(t => t.id));

  if (!results.length) {
    resultsEl.innerHTML = `
      <div class="search-empty">No matches.</div>
      <button class="search-manual">Add "${esc(query)}" as plain text</button>
    `;
    resultsEl.querySelector('.search-manual').addEventListener('click', () => {
      addManualTrack(query);
    });
    resultsEl.classList.remove('hidden');
    return;
  }

  resultsEl.innerHTML = results.map(t => `
    <button class="search-result ${existing.has(t.id) ? 'added' : ''}" data-id="${esc(t.id)}">
      <div class="cover-sm" style="${coverStyle(t)}">${t.cover ? '' : esc(initialsOf(t.title, t.artist))}</div>
      <div class="search-meta">
        <div class="search-title">${esc(t.title)}</div>
        <div class="search-artist">${esc(t.artist)}${t.album ? ' · ' + esc(t.album) : ''}</div>
      </div>
      <span class="search-add">${existing.has(t.id) ? '✓' : '+'}</span>
    </button>
  `).join('');

  resultsEl.querySelectorAll('.search-result').forEach(btn => {
    btn.addEventListener('click', () => {
      const id    = btn.dataset.id;
      const track = results.find(t => t.id === id);
      if (track) addTrack(track);
    });
  });
  resultsEl.classList.remove('hidden');
}

function hideSearchResults() {
  $('search-results').classList.add('hidden');
}

// ---------------------------------------------------------------------------
// Pool actions
// ---------------------------------------------------------------------------

async function addTrack(track) {
  if (!currentGame) return;
  if (currentGame.pool.some(t => t.id === track.id)) {
    toast('Already in the pool.');
    return;
  }
  try {
    await gameDoc().update({
      pool: firebase.firestore.FieldValue.arrayUnion(track)
    });
    $('input-search').value = '';
    hideSearchResults();
    $('input-search').focus();
  } catch {
    toast('Failed to add track.');
  }
}

async function addManualTrack(title) {
  const t = title.trim();
  if (!t || !currentGame) return;
  const track = {
    id:     `manual:${t.toLowerCase()}`,
    title:  t,
    artist: '—',
    album:  '',
    cover:  null,
    source: 'manual'
  };
  if (currentGame.pool.some(p => p.id === track.id)) {
    toast('Already in the pool.');
    return;
  }
  await gameDoc().update({
    pool: firebase.firestore.FieldValue.arrayUnion(track)
  }).catch(() => toast('Failed to add track.'));
  $('input-search').value = '';
  hideSearchResults();
  $('input-search').focus();
}

async function removeTrack(id) {
  if (!isHost || !currentGame) return;
  const track = currentGame.pool.find(t => t.id === id);
  if (!track) return;
  await gameDoc().update({
    pool: firebase.firestore.FieldValue.arrayRemove(track)
  });
}

async function kickPlayer(pid) {
  if (!isHost || !currentGame || pid === playerId) return;
  const p = currentGame.players?.[pid];
  if (!p || !confirm(`Kick ${p.name}?`)) return;
  await gameDoc().update({
    [`players.${pid}`]: firebase.firestore.FieldValue.delete()
  });
}

async function startGame() {
  if (!currentGame || currentGame.pool.length < 9) return;
  await gameDoc().update({ status: 'playing' });
}

async function confirmCard() {
  if (cardSelection.size !== 9) return;
  await gameDoc().update({
    [`players.${playerId}.card`]: [...cardSelection]
  });
}

async function toggleMark(trackId) {
  if (!currentGame || !isHost) return;
  const marked = currentGame.markedIds || [];
  const fn = marked.includes(trackId)
    ? firebase.firestore.FieldValue.arrayRemove
    : firebase.firestore.FieldValue.arrayUnion;
  await gameDoc().update({ markedIds: fn(trackId) });
}

function newGame() {
  if (unsubGame) { unsubGame(); unsubGame = null; }
  stopHostHeartbeat();
  stopGraceTicker();
  clearSave();
  gameId        = null;
  currentGame   = null;
  prevWinner    = null;
  cardSelection = new Set();
  isHost        = false;
  $('win-banner').classList.add('hidden');
  closePlayedSheet();
  showScreen('screen-welcome');
  setWelcomeMode('chooser');
}

// ---------------------------------------------------------------------------
// Subscription
// ---------------------------------------------------------------------------

function listenToGame() {
  if (unsubGame) unsubGame();
  startGraceTicker();

  unsubGame = gameDoc().onSnapshot(snap => {
    if (!snap.exists) {
      toast('Game ended.', 4000);
      newGame();
      return;
    }

    const prev  = currentGame;
    currentGame = snap.data();

    if (!currentGame.players?.[playerId]) {
      toast('You were removed from the game.', 4000);
      newGame();
      return;
    }

    const wasHost = isHost;
    isHost = currentGame.hostId === playerId;
    if (isHost && !wasHost) startHostHeartbeat();
    if (!isHost && wasHost) stopHostHeartbeat();

    handleGameUpdate(prev);
    updateGraceBanner();
  }, err => {
    // Snapshot listener can error on rule changes, auth expiry, etc.
    toast('Connection lost: ' + err.message, 4000);
  });
}

function handleGameUpdate(prev) {
  const game = currentGame;

  if (game.status === 'lobby') {
    renderLobby(game);
    showScreen('screen-lobby');
    return;
  }

  const me        = game.players?.[playerId];
  const markedSet = new Set(game.markedIds || []);

  if (!me?.card) {
    renderCardSelect(game);
    showScreen('screen-select');
  } else {
    renderBoard(game, prev, markedSet);
    showScreen('screen-game');
  }

  // Refresh open played sheet in real time.
  if (!$('played-sheet').classList.contains('hidden')) renderPlayedSheet();

  // Hide the played FAB for non-hosts
  $('btn-open-played').classList.toggle('hidden', !isHost);

  // Local bingo detection – the transaction resolves ties.
  if (me?.card && !me.hasWon && !game.winner && checkBingo(me.card, markedSet)) {
    claimWin();
  }

  if (game.winnerName && game.winnerName !== prevWinner) {
    prevWinner = game.winnerName;
    showWinBanner(game.winnerName, game.winner === playerId);
  }
}

// Transactional win claim – only the first writer wins on simultaneous bingo.
async function claimWin() {
  const ref = gameDoc();
  try {
    await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (snap.data().winner) return;
      tx.update(ref, {
        [`players.${playerId}.hasWon`]: true,
        winner:     playerId,
        winnerName: playerName,
        status:     'finished'
      });
    });
  } catch {}
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

function renderLobby(game) {
  $('lbl-game-code').textContent = gameId;

  const players = Object.entries(game.players || {});
  $('lbl-player-count').textContent = players.length;
  const ul = $('list-players');
  ul.innerHTML = '';
  for (const [pid, p] of players) {
    const isMe      = pid === playerId;
    const isHostRow = pid === game.hostId;
    const canKick   = isHost && !isHostRow && !isMe;
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="player-dot" style="background:${playerColor(pid)}"></span>
      <span>${esc(p.name)}${isMe ? ' (you)' : ''}</span>
      ${isHostRow ? '<span class="host-tag">Host</span>' : ''}
      ${canKick ? `<button class="btn-kick" data-pid="${esc(pid)}" title="Kick">✕</button>` : ''}
    `;
    ul.appendChild(li);
  }

  const pool = game.pool || [];
  $('lbl-pool-count').textContent = pool.length;
  const poolUl = $('list-pool');
  poolUl.innerHTML = '';
  for (const track of pool) {
    const li = document.createElement('li');
    li.innerHTML = `
      <div class="cover-sm" style="${coverStyle(track)}">${track.cover ? '' : esc(initialsOf(track.title, track.artist))}</div>
      <div class="pool-meta">
        <div class="pool-title">${esc(track.title)}</div>
        <div class="pool-artist">${esc(track.artist)}</div>
      </div>
      ${isHost ? `<button class="btn-remove" data-id="${esc(track.id)}" title="Remove">✕</button>` : ''}
    `;
    poolUl.appendChild(li);
  }

  $('host-controls').classList.toggle('hidden', !isHost);
  $('player-waiting').classList.toggle('hidden', isHost);

  if (isHost) {
    const startBtn = $('btn-start');
    const enough   = pool.length >= 9;
    startBtn.disabled    = !enough;
    startBtn.textContent = enough ? `Start Game (${pool.length} songs)` : 'Start Game';
    $('lbl-start-hint').textContent = enough
      ? 'Everyone ready? Start the game!'
      : `Add at least ${9 - pool.length} more song${9 - pool.length === 1 ? '' : 's'}.`;
  }
}

function renderCardSelect(game) {
  const grid = $('pool-grid');
  grid.innerHTML = '';

  // Drop selections whose tracks no longer exist in the pool.
  const poolIds = new Set(game.pool.map(t => t.id));
  for (const id of cardSelection) if (!poolIds.has(id)) cardSelection.delete(id);

  for (const track of game.pool) {
    const btn = document.createElement('button');
    btn.className = 'track-card' + (cardSelection.has(track.id) ? ' selected' : '');
    btn.innerHTML = `
      <div class="cover-lg" style="${coverStyle(track)}">${track.cover ? '' : esc(initialsOf(track.title, track.artist))}</div>
      <div class="track-title">${esc(track.title)}</div>
      <div class="track-artist">${esc(track.artist)}</div>
    `;
    btn.addEventListener('click', () => {
      if (cardSelection.has(track.id)) {
        cardSelection.delete(track.id);
        btn.classList.remove('selected');
      } else if (cardSelection.size < 9) {
        cardSelection.add(track.id);
        btn.classList.add('selected');
      }
      updateSelectCounter();
    });
    grid.appendChild(btn);
  }

  updateSelectCounter();
}

function updateSelectCounter() {
  const n = cardSelection.size;
  $('lbl-sel-count').textContent = n;
  $('btn-confirm').disabled = n !== 9;
}

function trackById(game, id) {
  return game.pool.find(t => t.id === id) || null;
}

function renderBoard(game, prev, markedSet) {
  const me      = game.players[playerId];
  const card    = me.card;
  const winLine = checkBingo(card, markedSet);
  const winSet  = new Set(winLine || []);

  $('lbl-code-game').textContent    = gameId;
  $('lbl-marked-count').textContent = (game.markedIds || []).length;
  $('lbl-my-name').textContent      = `Your card – ${playerName}`;

  const cardEl = $('my-card');
  cardEl.innerHTML = '';
  card.forEach((trackId, i) => {
    const track = trackById(game, trackId);
    if (!track) return;  // removed from pool after game started (unlikely)
    const cell = document.createElement('div');
    cell.className = 'bingo-cell';
    if (markedSet.has(trackId)) cell.classList.add('marked');
    if (winSet.has(i))          cell.classList.add('winning');
    cell.style.cssText = coverStyle(track);
    cell.innerHTML = `
      <div class="cell-overlay">
        <div class="cell-title">${esc(track.title)}</div>
        <div class="cell-artist">${esc(track.artist)}</div>
      </div>
    `;
    cell.addEventListener('click', () => {
      if (isHost) toggleMark(trackId);
    });
    cardEl.appendChild(cell);
  });

  $('lbl-my-progress').textContent = winLine
    ? 'BINGO!'
    : `Best line: ${maxLineProgress(card, markedSet)} / 3`;

  // Toast newly marked tracks (once per player, triggered by any mark).
  if (prev?.markedIds) {
    const prevSet = new Set(prev.markedIds);
    for (const id of game.markedIds || []) {
      if (!prevSet.has(id)) {
        const t = trackById(game, id) || trackById(prev, id);
        if (t) toast(`"${t.title}" played`, 2500);
      }
    }
  }

  const tagsEl = $('marked-tags');
  tagsEl.innerHTML = '';
  for (const id of game.markedIds || []) {
    const t = trackById(game, id);
    if (!t) continue;
    const span = document.createElement('span');
    span.className   = 'marked-tag';
    span.textContent = t.title;
    tagsEl.appendChild(span);
  }

  const othersEl = $('others-grid');
  othersEl.innerHTML = '';
  for (const [pid, p] of Object.entries(game.players)) {
    if (pid === playerId || !p.card) continue;
    othersEl.appendChild(renderOtherCard(pid, p, game, markedSet));
  }
}

function renderOtherCard(pid, p, game, markedSet) {
  const prog    = maxLineProgress(p.card, markedSet);
  const winLine = checkBingo(p.card, markedSet);
  const winSet  = new Set(winLine || []);
  const bingo   = !!winLine;
  const hot     = prog >= 2 && !bingo;

  const el = document.createElement('div');
  el.className = 'other-card' + (bingo ? ' bingo' : hot ? ' hot' : '');

  const badgeClass = bingo ? 'bingo' : hot ? 'hot' : '';
  const badgeText  = bingo ? 'BINGO!' : `${prog} / 3`;

  el.innerHTML = `
    <div class="other-header">
      <span class="other-name">
        <span class="other-dot" style="background:${playerColor(pid)}"></span>
        ${esc(p.name)}
      </span>
      <span class="prog-badge ${badgeClass}">${badgeText}</span>
    </div>
    <div class="mini-grid">
      ${p.card.map((id, i) => {
        const t = trackById(game, id);
        const style = t ? coverStyle(t) : 'background:#1f1f1f';
        const cls   = markedSet.has(id) ? (winSet.has(i) ? 'winning' : 'marked') : '';
        return `<div class="mini-cell ${cls}" style="${style}"></div>`;
      }).join('')}
    </div>
  `;
  return el;
}

function showWinBanner(name, isMe) {
  const banner = $('win-banner');
  $('win-text').innerHTML = isMe
    ? '<div class="win-title">BINGO!</div><div>You won!</div>'
    : `<div class="win-title">BINGO!</div><div>${esc(name)} won!</div>`;
  banner.classList.remove('hidden');
  if (!isMe) setTimeout(() => banner.classList.add('hidden'), 7000);
}

// ---------------------------------------------------------------------------
// Played bottom sheet
// ---------------------------------------------------------------------------

function openPlayedSheet() {
  $('played-sheet').classList.remove('hidden');
  $('input-played-filter').value = '';
  renderPlayedSheet();
  setTimeout(() => $('input-played-filter').focus(), 50);
}

function closePlayedSheet() {
  $('played-sheet').classList.add('hidden');
}

function renderPlayedSheet() {
  if (!currentGame) return;
  const filter = $('input-played-filter').value.trim().toLowerCase();
  const marked = new Set(currentGame.markedIds || []);
  const list   = $('played-list');

  const items = (currentGame.pool || []).filter(t =>
    !filter
    || t.title.toLowerCase().includes(filter)
    || (t.artist || '').toLowerCase().includes(filter)
  );

  if (!items.length) {
    list.innerHTML = '<div class="played-empty">No tracks match.</div>';
    return;
  }

  list.innerHTML = items.map(t => `
    <button class="played-row ${marked.has(t.id) ? 'is-marked' : ''}" data-id="${esc(t.id)}">
      <div class="cover-sm" style="${coverStyle(t)}">${t.cover ? '' : esc(initialsOf(t.title, t.artist))}</div>
      <div class="played-meta">
        <div class="played-title">${esc(t.title)}</div>
        <div class="played-artist">${esc(t.artist)}</div>
      </div>
      <span class="played-flag">${marked.has(t.id) ? 'Played' : 'Mark'}</span>
    </button>
  `).join('');

  list.querySelectorAll('.played-row').forEach(btn => {
    btn.addEventListener('click', () => toggleMark(btn.dataset.id));
  });
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

async function enterAdminFlow() {
  if (unsubGame) { unsubGame(); unsubGame = null; }
  stopHostHeartbeat();

  const u = auth.currentUser;
  if (u && !u.isAnonymous && u.uid === ADMIN_UID) {
    isAdmin = true;
    openAdminPanel();
    return;
  }

  if (u && u.isAnonymous) await auth.signOut().catch(() => {});
  isAdmin = false;
  showScreen('screen-admin-login');
  $('input-admin-email').value = '';
  $('input-admin-pass').value  = '';
  $('input-admin-email').focus();
}

async function adminLogin() {
  const email = $('input-admin-email').value.trim();
  const pass  = $('input-admin-pass').value;
  if (!email || !pass) { toast('Enter email and password.'); return; }

  try {
    const cred = await auth.signInWithEmailAndPassword(email, pass);
    if (cred.user.uid !== ADMIN_UID) {
      await auth.signOut();
      toast('Not authorized.', 4000);
      return;
    }
    isAdmin = true;
    openAdminPanel();
  } catch (e) {
    toast('Login failed: ' + (e.message || 'unknown error'), 5000);
  }
}

async function adminLogout() {
  if (unsubAdmin) { unsubAdmin(); unsubAdmin = null; }
  try { await auth.signOut(); } catch {}
  isAdmin = false;
  location.hash = '';
}

function openAdminPanel() {
  showScreen('screen-admin-panel');
  if (unsubAdmin) unsubAdmin();
  unsubAdmin = db.collection('games')
    .where('status', 'in', ['lobby', 'playing'])
    .onSnapshot(renderAdminSessions, err => toast('Admin listen error: ' + err.message, 5000));
}

function renderAdminSessions(snap) {
  const container = $('admin-sessions');
  const docs = snap.docs.slice().sort((a, b) => {
    const ta = a.data().createdAt?.toMillis?.() || 0;
    const tb = b.data().createdAt?.toMillis?.() || 0;
    return tb - ta;
  });

  $('lbl-session-count').textContent = docs.length;

  if (!docs.length) {
    container.innerHTML = '<p class="admin-empty">No active sessions.</p>';
    return;
  }

  container.innerHTML = '';
  for (const doc of docs) {
    const g        = doc.data();
    const players  = Object.values(g.players || {});
    const hostName = g.players?.[g.hostId]?.name || '—';

    const card = document.createElement('div');
    card.className = `session-card status-${esc(g.status)}`;
    card.innerHTML = `
      <div class="session-head">
        <span class="session-code">${esc(doc.id)}</span>
        <span class="session-status status-${esc(g.status)}">${esc(g.status)}</span>
      </div>
      <div class="session-meta">
        <div>Host: <strong>${esc(hostName)}</strong></div>
        <div>Created: ${formatDate(g.createdAt)} <span class="session-age">(${formatAge(g.createdAt)})</span></div>
        <div>Pool: ${(g.pool || []).length} songs · Played: ${(g.markedIds || []).length}</div>
      </div>
      <div class="session-players">
        <strong>${players.length} player${players.length === 1 ? '' : 's'}:</strong>
        ${players.map(p => esc(p.name)).join(', ') || '—'}
      </div>
      <button class="btn btn-terminate btn-sm" data-id="${esc(doc.id)}">Terminate</button>
    `;
    card.querySelector('.btn-terminate').addEventListener('click', () => terminateGame(doc.id));
    container.appendChild(card);
  }
}

async function terminateGame(id) {
  if (!confirm(`Terminate session ${id}? All players will be disconnected.`)) return;
  try {
    await db.collection('games').doc(id).delete();
    toast(`Session ${id} terminated.`, 3000);
  } catch (e) {
    toast('Failed to terminate: ' + e.message, 5000);
  }
}
