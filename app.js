// ============================================================
// Music Bingo – app.js
// ============================================================

const ADMIN_UID        = 'bNAAXb9LreTJjuKQLjRBlLOUH2X2';
const MAX_ACTIVE_GAMES = 3;

const LINES = [
  [0,1,2],[3,4,5],[6,7,8],   // rows
  [0,3,6],[1,4,7],[2,5,8],   // cols
  [0,4,8],[2,4,6]            // diagonals
];

const COLORS = ['#e0335c','#7c4dff','#00b0d8','#ff8c00','#3dba6f','#e040fb','#26c6da'];

const auth = firebase.auth();
const db   = firebase.firestore();
auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(() => {});

// ── State ──────────────────────────────────────────────────
let gameId        = null;
let playerId      = null;         // Firebase Auth UID
let playerName    = null;
let isHost        = false;
let currentGame   = null;
let unsubscribe   = null;
let unsubAdmin    = null;
let cardSelection = new Set();
let prevWinner    = null;
let isAdmin       = false;

// ── Helpers ────────────────────────────────────────────────

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({length: 6}, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function playerColor(id) {
  let h = 0;
  for (const c of id) h = (h + c.charCodeAt(0)) % COLORS.length;
  return COLORS[h];
}

function esc(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function showToast(msg, ms = 3000) {
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
  const diffMs = Date.now() - d.getTime();
  const mins  = Math.floor(diffMs / 60000);
  if (mins < 1)    return 'just now';
  if (mins < 60)   return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24)  return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

// ── Bingo logic ────────────────────────────────────────────

function checkBingo(card, markedSongs) {
  if (!card || card.length !== 9) return null;
  const m = new Set(markedSongs);
  for (const line of LINES) {
    if (line.every(i => m.has(card[i]))) return line;
  }
  return null;
}

function maxLineProgress(card, markedSongs) {
  if (!card || card.length !== 9) return 0;
  const m = new Set(markedSongs);
  return Math.max(...LINES.map(line => line.filter(i => m.has(card[i])).length));
}

// ── Auth ───────────────────────────────────────────────────

async function ensureAnonymousAuth() {
  if (auth.currentUser && auth.currentUser.isAnonymous) {
    playerId = auth.currentUser.uid;
    return;
  }
  // If signed in as admin, sign out first
  if (auth.currentUser && !auth.currentUser.isAnonymous) {
    await auth.signOut();
  }
  const cred = await auth.signInAnonymously();
  playerId = cred.user.uid;
}

function authStateReady() {
  return new Promise(resolve => {
    const unsub = auth.onAuthStateChanged(user => {
      unsub();
      resolve(user);
    });
  });
}

// ── Init ───────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  // Welcome – mode chooser
  document.getElementById('btn-mode-create').addEventListener('click', () => setWelcomeMode('create'));
  document.getElementById('btn-mode-join').addEventListener('click',   () => setWelcomeMode('join'));
  document.querySelectorAll('.back-link[data-back="chooser"]').forEach(b =>
    b.addEventListener('click', () => setWelcomeMode('chooser'))
  );

  // Welcome – actions
  document.getElementById('btn-create').addEventListener('click', createGame);
  document.getElementById('btn-join').addEventListener('click', joinGame);
  document.getElementById('input-name-create').addEventListener('keydown', e => e.key === 'Enter' && createGame());
  document.getElementById('input-name-join').addEventListener('keydown',   e => e.key === 'Enter' && joinGame());
  document.getElementById('input-code').addEventListener('keydown',        e => e.key === 'Enter' && joinGame());

  // Lobby
  document.getElementById('btn-copy').addEventListener('click', () => {
    navigator.clipboard.writeText(gameId).then(() => showToast('Code copied!'));
  });
  document.getElementById('btn-add-song').addEventListener('click', addSong);
  document.getElementById('input-song').addEventListener('keydown', e => e.key === 'Enter' && addSong());
  document.getElementById('btn-start').addEventListener('click', startGame);
  document.getElementById('btn-leave-lobby').addEventListener('click', leaveGame);

  // Event delegation for pool remove + player kick
  document.getElementById('list-pool').addEventListener('click', e => {
    const btn = e.target.closest('.btn-remove');
    if (btn) removeSong(btn.dataset.song);
  });
  document.getElementById('list-players').addEventListener('click', e => {
    const btn = e.target.closest('.btn-kick');
    if (btn) kickPlayer(btn.dataset.pid);
  });

  // Card selection
  document.getElementById('btn-confirm').addEventListener('click', confirmCard);

  // Game
  document.getElementById('btn-new-game').addEventListener('click', newGame);

  // Win banner
  document.getElementById('btn-close-banner').addEventListener('click', () => {
    document.getElementById('win-banner').classList.add('hidden');
  });

  // Admin
  document.getElementById('btn-admin-login').addEventListener('click', adminLogin);
  document.getElementById('input-admin-pass').addEventListener('keydown', e => e.key === 'Enter' && adminLogin());
  document.getElementById('btn-admin-logout').addEventListener('click', adminLogout);
  document.getElementById('link-admin-back').addEventListener('click', e => {
    e.preventDefault();
    location.hash = '';
  });

  window.addEventListener('hashchange', route);

  // Wait for auth to finish initializing
  await authStateReady();
  await route();
});

// ── Routing ────────────────────────────────────────────────

async function route() {
  const hash = location.hash.replace(/^#/, '');

  // Clean up any existing listeners when switching flows
  if (hash === 'admin') {
    await enterAdminFlow();
    return;
  }

  // Leaving admin?
  if (unsubAdmin) { unsubAdmin(); unsubAdmin = null; }
  if (isAdmin) {
    isAdmin = false;
    if (auth.currentUser && !auth.currentUser.isAnonymous) await auth.signOut();
  }

  await ensureAnonymousAuth();
  await tryReconnect();
}

// ── Welcome mode switcher ──────────────────────────────────

function setWelcomeMode(mode) {
  const chooser = document.getElementById('welcome-chooser');
  const create  = document.getElementById('welcome-create');
  const join    = document.getElementById('welcome-join');

  chooser.classList.toggle('hidden', mode !== 'chooser');
  create.classList.toggle('hidden',  mode !== 'create');
  join.classList.toggle('hidden',    mode !== 'join');

  if (mode === 'create') document.getElementById('input-name-create').focus();
  if (mode === 'join')   document.getElementById('input-name-join').focus();
}

// ── Reconnect ──────────────────────────────────────────────

async function tryReconnect() {
  showScreen('screen-welcome');
  setWelcomeMode('chooser');

  const savedId   = localStorage.getItem('bingo_gid');
  const savedName = localStorage.getItem('bingo_name');
  if (!savedId || !savedName) return;

  try {
    const snap = await db.collection('games').doc(savedId).get();
    if (!snap.exists) { clearSave(); return; }
    const game = snap.data();
    if (!game.players?.[playerId]) { clearSave(); return; }

    gameId     = savedId;
    playerName = savedName;
    isHost     = game.hostId === playerId;

    listenToGame();
  } catch (_) { /* ignore */ }
}

function clearSave() {
  localStorage.removeItem('bingo_gid');
  localStorage.removeItem('bingo_name');
}

// ── Create / Join ──────────────────────────────────────────

async function createGame() {
  const name = document.getElementById('input-name-create').value.trim();
  if (!name) { showToast('Please enter your name!'); return; }

  await ensureAnonymousAuth();

  // Count active games (lobby + playing)
  let activeSnap;
  try {
    activeSnap = await db.collection('games').where('status', 'in', ['lobby', 'playing']).get();
  } catch (e) {
    showToast('Connection error.');
    return;
  }

  // If I already host an active game, delete it (replace with new)
  const myOwn = activeSnap.docs.find(d => d.data().hostId === playerId);
  const othersCount = activeSnap.docs.filter(d => d.data().hostId !== playerId).length;

  if (othersCount >= MAX_ACTIVE_GAMES) {
    showToast('Server limit reached. Please try again later.', 5000);
    return;
  }

  if (myOwn) {
    try { await db.collection('games').doc(myOwn.id).delete(); } catch (_) {}
  }

  playerName = name;
  isHost     = true;
  gameId     = generateCode();

  localStorage.setItem('bingo_gid',  gameId);
  localStorage.setItem('bingo_name', name);

  try {
    await db.collection('games').doc(gameId).set({
      hostId:      playerId,
      status:      'lobby',
      pool:        [],
      markedSongs: [],
      players: {
        [playerId]: { name, card: null, hasWon: false }
      },
      winner:     null,
      winnerName: null,
      createdAt:  firebase.firestore.FieldValue.serverTimestamp()
    });
  } catch (e) {
    showToast('Failed to create game.');
    clearSave();
    return;
  }

  listenToGame();
}

async function joinGame() {
  const name = document.getElementById('input-name-join').value.trim();
  const code = document.getElementById('input-code').value.trim().toUpperCase();

  if (!name) { showToast('Please enter your name!'); return; }
  if (!code) { showToast('Please enter game code!'); return; }

  await ensureAnonymousAuth();

  let snap;
  try {
    snap = await db.collection('games').doc(code).get();
  } catch (_) {
    showToast('Connection error.'); return;
  }
  if (!snap.exists)                   { showToast('Game not found.'); return; }
  if (snap.data().status !== 'lobby') { showToast('Game already started or finished.'); return; }

  playerName = name;
  gameId     = code;
  isHost     = snap.data().hostId === playerId;

  localStorage.setItem('bingo_gid',  gameId);
  localStorage.setItem('bingo_name', name);

  await db.collection('games').doc(gameId).update({
    [`players.${playerId}`]: { name, card: null, hasWon: false }
  });

  listenToGame();
}

async function leaveGame() {
  if (!gameId) { newGame(); return; }
  const id = gameId;
  const wasHost = isHost;

  if (unsubscribe) { unsubscribe(); unsubscribe = null; }

  try {
    if (wasHost) {
      await db.collection('games').doc(id).delete();
    } else {
      await db.collection('games').doc(id).update({
        [`players.${playerId}`]: firebase.firestore.FieldValue.delete()
      });
    }
  } catch (_) {}

  newGame();
}

// ── Lobby actions ──────────────────────────────────────────

async function addSong() {
  const input = document.getElementById('input-song');
  const song  = input.value.trim();
  if (!song)        return;
  if (!currentGame) return;

  const exists = currentGame.pool.some(s => s.toLowerCase() === song.toLowerCase());
  if (exists) { showToast('This song is already in the pool!'); return; }

  await db.collection('games').doc(gameId).update({
    pool: firebase.firestore.FieldValue.arrayUnion(song)
  });
  input.value = '';
  input.focus();
}

async function removeSong(song) {
  if (!isHost) return;
  await db.collection('games').doc(gameId).update({
    pool: firebase.firestore.FieldValue.arrayRemove(song)
  });
}

async function kickPlayer(pid) {
  if (!isHost || !currentGame) return;
  if (pid === playerId) return;
  const p = currentGame.players?.[pid];
  if (!p) return;
  if (!confirm(`Kick ${p.name}?`)) return;

  await db.collection('games').doc(gameId).update({
    [`players.${pid}`]: firebase.firestore.FieldValue.delete()
  });
}

async function startGame() {
  if (!currentGame || currentGame.pool.length < 9) return;
  await db.collection('games').doc(gameId).update({ status: 'playing' });
}

// ── Card selection ─────────────────────────────────────────

async function confirmCard() {
  if (cardSelection.size !== 9) return;
  const selected = [...cardSelection];
  await db.collection('games').doc(gameId).update({
    [`players.${playerId}.card`]: selected
  });
}

// ── Game: mark / unmark ────────────────────────────────────

async function toggleSong(song) {
  if (!currentGame) return;
  const isMarked = currentGame.markedSongs.includes(song);
  await db.collection('games').doc(gameId).update({
    markedSongs: isMarked
      ? firebase.firestore.FieldValue.arrayRemove(song)
      : firebase.firestore.FieldValue.arrayUnion(song)
  });
}

// ── New game ───────────────────────────────────────────────

function newGame() {
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  clearSave();
  gameId        = null;
  currentGame   = null;
  prevWinner    = null;
  cardSelection = new Set();
  isHost        = false;
  document.getElementById('win-banner').classList.add('hidden');
  showScreen('screen-welcome');
  setWelcomeMode('chooser');
}

// ── Firebase listener ──────────────────────────────────────

function listenToGame() {
  if (unsubscribe) unsubscribe();

  unsubscribe = db.collection('games').doc(gameId).onSnapshot(snap => {
    if (!snap.exists) {
      // Game was deleted (e.g. host left, admin terminated, or TTL cleared it)
      showToast('Game ended.', 4000);
      newGame();
      return;
    }
    const prev  = currentGame;
    currentGame = snap.data();

    // Was I kicked?
    if (!currentGame.players?.[playerId]) {
      showToast('You were removed from the game.', 4000);
      newGame();
      return;
    }

    isHost = currentGame.hostId === playerId;
    onGameUpdate(prev);
  });
}

// ── Main update handler ────────────────────────────────────

function onGameUpdate(prev) {
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

  if (me?.card && !me.hasWon && !game.winner) {
    const win = checkBingo(me.card, game.markedSongs);
    if (win) claimWin();
  }

  if (game.winnerName && game.winnerName !== prevWinner) {
    prevWinner = game.winnerName;
    showWinBanner(game.winnerName, game.winner === playerId);
  }
}

// ── Claim win (transaction to avoid race) ─────────────────

async function claimWin() {
  const ref = db.collection('games').doc(gameId);
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
  } catch (_) { /* ignore */ }
}

// ── Render: Lobby ──────────────────────────────────────────

function renderLobby(game) {
  document.getElementById('lbl-game-code').textContent = gameId;

  const players = Object.entries(game.players || {});
  document.getElementById('lbl-player-count').textContent = players.length;
  const ul = document.getElementById('list-players');
  ul.innerHTML = '';
  players.forEach(([pid, p]) => {
    const li = document.createElement('li');
    const color = playerColor(pid);
    const isMe      = pid === playerId;
    const isHostRow = pid === game.hostId;
    const kickBtn   = (isHost && !isHostRow && !isMe)
      ? `<button class="btn-kick" data-pid="${esc(pid)}" title="Kick">✕</button>`
      : '';
    li.innerHTML = `
      <span class="player-dot" style="background:${color}"></span>
      <span>${esc(p.name)}${isMe ? ' (you)' : ''}</span>
      ${isHostRow ? '<span class="host-tag">Host</span>' : ''}
      ${kickBtn}
    `;
    ul.appendChild(li);
  });

  const pool = game.pool || [];
  document.getElementById('lbl-pool-count').textContent = pool.length;
  const poolUl = document.getElementById('list-pool');
  poolUl.innerHTML = '';
  pool.forEach(song => {
    const li = document.createElement('li');
    li.innerHTML = `
      <span>${esc(song)}</span>
      ${isHost ? `<button class="btn-remove" data-song="${esc(song)}" title="Remove">✕</button>` : ''}
    `;
    poolUl.appendChild(li);
  });

  const startBtn  = document.getElementById('btn-start');
  const startHint = document.getElementById('lbl-start-hint');
  document.getElementById('host-controls').classList.toggle('hidden', !isHost);
  document.getElementById('player-waiting').classList.toggle('hidden', isHost);

  if (isHost) {
    const enough = pool.length >= 9;
    startBtn.disabled = !enough;
    startBtn.textContent = enough
      ? `Start Game (${pool.length} songs)`
      : `Start Game`;
    startHint.textContent = enough
      ? 'Everyone ready? Start the game!'
      : `Add at least ${9 - pool.length} more song${9 - pool.length === 1 ? '' : 's'}.`;
  }
}

// ── Render: Card selection ─────────────────────────────────

function renderCardSelect(game) {
  const grid = document.getElementById('pool-grid');
  grid.innerHTML = '';

  game.pool.forEach(song => {
    const btn = document.createElement('button');
    btn.className = 'song-btn' + (cardSelection.has(song) ? ' selected' : '');
    btn.textContent = song;

    btn.addEventListener('click', () => {
      if (cardSelection.has(song)) {
        cardSelection.delete(song);
        btn.classList.remove('selected');
      } else if (cardSelection.size < 9) {
        cardSelection.add(song);
        btn.classList.add('selected');
      }
      const count = cardSelection.size;
      document.getElementById('lbl-sel-count').textContent = count;
      document.getElementById('btn-confirm').disabled = count !== 9;
    });

    grid.appendChild(btn);
  });

  const count = cardSelection.size;
  document.getElementById('lbl-sel-count').textContent = count;
  document.getElementById('btn-confirm').disabled = count !== 9;
}

// ── Render: Game board ─────────────────────────────────────

function renderBoard(game, prev) {
  const me          = game.players[playerId];
  const card        = me.card;
  const marked      = game.markedSongs || [];
  const markedSet   = new Set(marked);
  const winLine     = checkBingo(card, marked);
  const winLineSet  = new Set(winLine || []);

  document.getElementById('lbl-code-game').textContent    = gameId;
  document.getElementById('lbl-marked-count').textContent = marked.length;
  document.getElementById('lbl-my-name').textContent      = `Your card – ${playerName}`;

  const cardEl = document.getElementById('my-card');
  cardEl.innerHTML = '';
  card.forEach((song, i) => {
    const cell = document.createElement('div');
    cell.className = 'bingo-cell';
    if (markedSet.has(song)) cell.classList.add('marked');
    if (winLineSet.has(i))   cell.classList.add('winning');
    cell.textContent = song;
    cell.addEventListener('click', () => toggleSong(song));
    cardEl.appendChild(cell);
  });

  const prog = maxLineProgress(card, marked);
  document.getElementById('lbl-my-progress').textContent = winLine
    ? '🏆 BINGO!'
    : `Best line: ${prog} / 3`;

  const tagsEl = document.getElementById('marked-tags');
  tagsEl.innerHTML = '';
  marked.forEach(song => {
    const span = document.createElement('span');
    span.className = 'marked-tag';
    span.textContent = song;
    tagsEl.appendChild(span);
  });

  if (prev?.markedSongs) {
    const fresh = marked.filter(s => !prev.markedSongs.includes(s));
    fresh.forEach(s => showToast(`🎵 "${s}" played!`, 2500));
  }

  const othersEl = document.getElementById('others-grid');
  othersEl.innerHTML = '';
  Object.entries(game.players).forEach(([pid, p]) => {
    if (pid === playerId || !p.card) return;

    const pProg     = maxLineProgress(p.card, marked);
    const pWinLine  = checkBingo(p.card, marked);
    const pWinSet   = new Set(pWinLine || []);
    const isBingo   = !!pWinLine;
    const isHot     = pProg >= 2 && !isBingo;
    const color     = playerColor(pid);

    const card = document.createElement('div');
    card.className = 'other-card' + (isBingo ? ' bingo' : isHot ? ' hot' : '');

    const badgeClass = isBingo ? 'bingo' : isHot ? 'hot' : '';
    const badgeText  = isBingo ? '🏆 BINGO!' : `${pProg} / 3`;

    card.innerHTML = `
      <div class="other-header">
        <span class="other-name">
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};flex-shrink:0"></span>
          ${esc(p.name)}
        </span>
        <span class="prog-badge ${badgeClass}">${badgeText}</span>
      </div>
      <div class="mini-grid">
        ${p.card.map((song, i) => `
          <div class="mini-cell ${markedSet.has(song) ? (pWinSet.has(i) ? 'winning' : 'marked') : ''}">
            ${esc(song)}
          </div>
        `).join('')}
      </div>
    `;

    othersEl.appendChild(card);
  });
}

// ── Win banner ─────────────────────────────────────────────

function showWinBanner(name, isMe) {
  const banner = document.getElementById('win-banner');
  const textEl = document.getElementById('win-text');

  textEl.innerHTML = isMe
    ? '<div style="font-size:2rem;margin-bottom:4px">BINGO!</div><div>You won! 🎉</div>'
    : `<div style="font-size:1.6rem;margin-bottom:4px">BINGO!</div><div>${esc(name)} won!</div>`;

  banner.classList.remove('hidden');

  if (!isMe) setTimeout(() => banner.classList.add('hidden'), 7000);
}

// ── Admin flow ─────────────────────────────────────────────

async function enterAdminFlow() {
  // Stop player listeners
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }

  const user = auth.currentUser;
  if (user && !user.isAnonymous && user.uid === ADMIN_UID) {
    isAdmin = true;
    openAdminPanel();
  } else {
    if (user && user.isAnonymous) await auth.signOut().catch(() => {});
    isAdmin = false;
    showScreen('screen-admin-login');
    document.getElementById('input-admin-email').value = '';
    document.getElementById('input-admin-pass').value  = '';
    document.getElementById('input-admin-email').focus();
  }
}

async function adminLogin() {
  const email = document.getElementById('input-admin-email').value.trim();
  const pass  = document.getElementById('input-admin-pass').value;
  if (!email || !pass) { showToast('Enter email and password.'); return; }

  try {
    const cred = await auth.signInWithEmailAndPassword(email, pass);
    if (cred.user.uid !== ADMIN_UID) {
      await auth.signOut();
      showToast('Not authorized.', 4000);
      return;
    }
    isAdmin = true;
    openAdminPanel();
  } catch (e) {
    showToast('Login failed: ' + (e.message || 'unknown error'), 5000);
  }
}

async function adminLogout() {
  if (unsubAdmin) { unsubAdmin(); unsubAdmin = null; }
  try { await auth.signOut(); } catch (_) {}
  isAdmin = false;
  location.hash = '';
}

function openAdminPanel() {
  showScreen('screen-admin-panel');
  if (unsubAdmin) unsubAdmin();
  unsubAdmin = db.collection('games')
    .where('status', 'in', ['lobby', 'playing'])
    .onSnapshot(renderAdminSessions, err => {
      showToast('Admin listen error: ' + err.message, 5000);
    });
}

function renderAdminSessions(snap) {
  const container = document.getElementById('admin-sessions');
  const countEl   = document.getElementById('lbl-session-count');

  const docs = snap.docs.slice().sort((a, b) => {
    const ta = a.data().createdAt?.toMillis?.() || 0;
    const tb = b.data().createdAt?.toMillis?.() || 0;
    return tb - ta;
  });

  countEl.textContent = docs.length;

  if (docs.length === 0) {
    container.innerHTML = '<p class="admin-empty">No active sessions.</p>';
    return;
  }

  container.innerHTML = '';
  docs.forEach(doc => {
    const g = doc.data();
    const players = Object.values(g.players || {});
    const hostName = g.players?.[g.hostId]?.name || '—';

    const card = document.createElement('div');
    card.className = 'session-card';
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
  });
}

async function terminateGame(id) {
  if (!confirm(`Terminate session ${id}? All players will be disconnected.`)) return;
  try {
    await db.collection('games').doc(id).delete();
    showToast(`Session ${id} terminated.`, 3000);
  } catch (e) {
    showToast('Failed to terminate: ' + e.message, 5000);
  }
}
