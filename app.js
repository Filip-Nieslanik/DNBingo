// DNBingo client.
// Real-time 3x3 music bingo on top of Firestore.
// Players sign in anonymously (Auth UID = playerId), admin uses email/password.

const ADMIN_UID        = 'bNAAXb9LreTJjuKQLjRBlLOUH2X2';
const MAX_ACTIVE_GAMES = 3;

// Winning lines as cell indices on a 3x3 grid.
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

// Shorthands
const $ = id => document.getElementById(id);
const gameDoc = () => db.collection('games').doc(gameId);

// Helpers
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

// Bingo logic
function checkBingo(card, marked) {
  if (!card || card.length !== 9) return null;
  const m = new Set(marked);
  for (const line of LINES) {
    if (line.every(i => m.has(card[i]))) return line;
  }
  return null;
}

function maxLineProgress(card, marked) {
  if (!card || card.length !== 9) return 0;
  const m = new Set(marked);
  return Math.max(...LINES.map(line => line.filter(i => m.has(card[i])).length));
}

// Auth
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

// Init
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

  $('btn-copy').addEventListener('click', () => {
    navigator.clipboard.writeText(gameId).then(() => toast('Code copied!'));
  });
  $('btn-add-song').addEventListener('click', addSong);
  $('input-song').addEventListener('keydown', e => e.key === 'Enter' && addSong());
  $('btn-start').addEventListener('click', startGame);
  $('btn-leave-lobby').addEventListener('click', leaveGame);

  $('list-pool').addEventListener('click', e => {
    const btn = e.target.closest('.btn-remove');
    if (btn) removeSong(btn.dataset.song);
  });
  $('list-players').addEventListener('click', e => {
    const btn = e.target.closest('.btn-kick');
    if (btn) kickPlayer(btn.dataset.pid);
  });

  $('btn-confirm').addEventListener('click', confirmCard);
  $('btn-new-game').addEventListener('click', newGame);
  $('btn-close-banner').addEventListener('click', () => $('win-banner').classList.add('hidden'));

  $('btn-admin-login').addEventListener('click', adminLogin);
  $('input-admin-pass').addEventListener('keydown', e => e.key === 'Enter' && adminLogin());
  $('btn-admin-logout').addEventListener('click', adminLogout);
  $('link-admin-back').addEventListener('click', e => {
    e.preventDefault();
    location.hash = '';
  });

  window.addEventListener('hashchange', route);

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
    const snap = await db.collection('games').doc(savedId).get();
    if (!snap.exists || !snap.data().players?.[playerId]) {
      clearSave();
      return;
    }
    gameId     = savedId;
    playerName = savedName;
    isHost     = snap.data().hostId === playerId;
    listenToGame();
  } catch { /* offline or rules reject — stay on welcome */ }
}

function clearSave() {
  localStorage.removeItem('bingo_gid');
  localStorage.removeItem('bingo_name');
}

// Create / join / leave
async function createGame() {
  const name = $('input-name-create').value.trim();
  if (!name) { toast('Please enter your name!'); return; }

  await ensureAnonymousAuth();

  let active;
  try {
    active = await db.collection('games').where('status', 'in', ['lobby', 'playing']).get();
  } catch {
    toast('Connection error.');
    return;
  }

  // If the same user already hosts a game, replace it instead of stacking.
  const myOwn = active.docs.find(d => d.data().hostId === playerId);
  const othersCount = active.size - (myOwn ? 1 : 0);

  if (othersCount >= MAX_ACTIVE_GAMES) {
    toast('Server limit reached. Please try again later.', 5000);
    return;
  }

  if (myOwn) {
    try { await db.collection('games').doc(myOwn.id).delete(); } catch {}
  }

  playerName = name;
  isHost     = true;
  gameId     = generateCode();

  localStorage.setItem('bingo_gid',  gameId);
  localStorage.setItem('bingo_name', name);

  try {
    await gameDoc().set({
      hostId:      playerId,
      status:      'lobby',
      pool:        [],
      markedSongs: [],
      players:     { [playerId]: { name, card: null, hasWon: false } },
      winner:      null,
      winnerName:  null,
      createdAt:   firebase.firestore.FieldValue.serverTimestamp()
    });
  } catch {
    toast('Failed to create game.');
    clearSave();
    return;
  }

  listenToGame();
}

async function joinGame() {
  const name = $('input-name-join').value.trim();
  const code = $('input-code').value.trim().toUpperCase();
  if (!name) { toast('Please enter your name!'); return; }
  if (!code) { toast('Please enter game code!'); return; }

  await ensureAnonymousAuth();

  let snap;
  try { snap = await db.collection('games').doc(code).get(); }
  catch { toast('Connection error.'); return; }

  if (!snap.exists)                   { toast('Game not found.'); return; }
  if (snap.data().status !== 'lobby') { toast('Game already started or finished.'); return; }

  playerName = name;
  gameId     = code;
  isHost     = snap.data().hostId === playerId;

  localStorage.setItem('bingo_gid',  gameId);
  localStorage.setItem('bingo_name', name);

  await gameDoc().update({
    [`players.${playerId}`]: { name, card: null, hasWon: false }
  });

  listenToGame();
}

async function leaveGame() {
  if (!gameId) { newGame(); return; }
  const id = gameId;
  const wasHost = isHost;
  if (unsubGame) { unsubGame(); unsubGame = null; }

  try {
    if (wasHost) {
      await db.collection('games').doc(id).delete();
    } else {
      await db.collection('games').doc(id).update({
        [`players.${playerId}`]: firebase.firestore.FieldValue.delete()
      });
    }
  } catch {}

  newGame();
}

// Lobby actions
async function addSong() {
  const input = $('input-song');
  const song  = input.value.trim();
  if (!song || !currentGame) return;

  if (currentGame.pool.some(s => s.toLowerCase() === song.toLowerCase())) {
    toast('This song is already in the pool!');
    return;
  }

  await gameDoc().update({
    pool: firebase.firestore.FieldValue.arrayUnion(song)
  });
  input.value = '';
  input.focus();
}

async function removeSong(song) {
  if (!isHost) return;
  await gameDoc().update({
    pool: firebase.firestore.FieldValue.arrayRemove(song)
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

async function toggleSong(song) {
  if (!currentGame) return;
  const fn = currentGame.markedSongs.includes(song)
    ? firebase.firestore.FieldValue.arrayRemove
    : firebase.firestore.FieldValue.arrayUnion;
  await gameDoc().update({ markedSongs: fn(song) });
}

function newGame() {
  if (unsubGame) { unsubGame(); unsubGame = null; }
  clearSave();
  gameId        = null;
  currentGame   = null;
  prevWinner    = null;
  cardSelection = new Set();
  isHost        = false;
  $('win-banner').classList.add('hidden');
  showScreen('screen-welcome');
  setWelcomeMode('chooser');
}

// Game subscription
function listenToGame() {
  if (unsubGame) unsubGame();

  unsubGame = gameDoc().onSnapshot(snap => {
    if (!snap.exists) {
      toast('Game ended.', 4000);
      newGame();
      return;
    }

    const prev = currentGame;
    currentGame = snap.data();

    if (!currentGame.players?.[playerId]) {
      toast('You were removed from the game.', 4000);
      newGame();
      return;
    }

    isHost = currentGame.hostId === playerId;
    handleGameUpdate(prev);
  });
}

function handleGameUpdate(prev) {
  const game = currentGame;

  if (game.status === 'lobby') {
    renderLobby(game);
    showScreen('screen-lobby');
    return;
  }

  const me = game.players?.[playerId];
  if (!me?.card) {
    renderCardSelect(game);
    showScreen('screen-select');
  } else {
    renderBoard(game, prev);
    showScreen('screen-game');
  }

  // Local bingo detection – the transaction below resolves races.
  if (me?.card && !me.hasWon && !game.winner && checkBingo(me.card, game.markedSongs)) {
    claimWin();
  }

  if (game.winnerName && game.winnerName !== prevWinner) {
    prevWinner = game.winnerName;
    showWinBanner(game.winnerName, game.winner === playerId);
  }
}

// Transactional win claim — only the first writer wins if two players finish simultaneously.
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

// Renderers
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
  for (const song of pool) {
    const li = document.createElement('li');
    li.innerHTML = `
      <span>${esc(song)}</span>
      ${isHost ? `<button class="btn-remove" data-song="${esc(song)}" title="Remove">✕</button>` : ''}
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

  for (const song of game.pool) {
    const btn = document.createElement('button');
    btn.className   = 'song-btn' + (cardSelection.has(song) ? ' selected' : '');
    btn.textContent = song;
    btn.addEventListener('click', () => {
      if (cardSelection.has(song)) {
        cardSelection.delete(song);
        btn.classList.remove('selected');
      } else if (cardSelection.size < 9) {
        cardSelection.add(song);
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

function renderBoard(game, prev) {
  const me        = game.players[playerId];
  const card      = me.card;
  const marked    = game.markedSongs || [];
  const markedSet = new Set(marked);
  const winLine   = checkBingo(card, marked);
  const winSet    = new Set(winLine || []);

  $('lbl-code-game').textContent    = gameId;
  $('lbl-marked-count').textContent = marked.length;
  $('lbl-my-name').textContent      = `Your card – ${playerName}`;

  const cardEl = $('my-card');
  cardEl.innerHTML = '';
  card.forEach((song, i) => {
    const cell = document.createElement('div');
    cell.className = 'bingo-cell';
    if (markedSet.has(song)) cell.classList.add('marked');
    if (winSet.has(i))       cell.classList.add('winning');
    cell.textContent = song;
    cell.addEventListener('click', () => toggleSong(song));
    cardEl.appendChild(cell);
  });

  $('lbl-my-progress').textContent = winLine
    ? 'BINGO!'
    : `Best line: ${maxLineProgress(card, marked)} / 3`;

  const tagsEl = $('marked-tags');
  tagsEl.innerHTML = '';
  for (const song of marked) {
    const span = document.createElement('span');
    span.className   = 'marked-tag';
    span.textContent = song;
    tagsEl.appendChild(span);
  }

  // Toast each newly marked song (once per player, triggered by any mark).
  if (prev?.markedSongs) {
    for (const s of marked) {
      if (!prev.markedSongs.includes(s)) toast(`"${s}" played`, 2500);
    }
  }

  const othersEl = $('others-grid');
  othersEl.innerHTML = '';
  for (const [pid, p] of Object.entries(game.players)) {
    if (pid === playerId || !p.card) continue;
    othersEl.appendChild(renderOtherCard(pid, p, marked, markedSet));
  }
}

function renderOtherCard(pid, p, marked, markedSet) {
  const prog    = maxLineProgress(p.card, marked);
  const winLine = checkBingo(p.card, marked);
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
      ${p.card.map((song, i) => `
        <div class="mini-cell ${markedSet.has(song) ? (winSet.has(i) ? 'winning' : 'marked') : ''}">${esc(song)}</div>
      `).join('')}
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

// Admin
async function enterAdminFlow() {
  if (unsubGame) { unsubGame(); unsubGame = null; }

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
        <div>Pool: ${(g.pool || []).length} songs · Played: ${(g.markedSongs || []).length}</div>
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
