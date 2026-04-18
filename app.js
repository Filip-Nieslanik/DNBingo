// ============================================================
// Music Bingo – app.js
// ============================================================

const db = firebase.firestore();

// ── State ──────────────────────────────────────────────────
let gameId        = null;
let playerId      = getOrCreatePlayerId();
let playerName    = null;
let isHost        = false;
let currentGame   = null;
let unsubscribe   = null;
let cardSelection = new Set();   // in-progress card selection
let prevWinner    = null;        // to detect new winner notification
let prevMarked    = [];          // to detect newly marked songs

// ── Bingo lines (positions 0-8 in a 3x3 grid) ──────────────
const LINES = [
  [0,1,2],[3,4,5],[6,7,8],   // rows
  [0,3,6],[1,4,7],[2,5,8],   // cols
  [0,4,8],[2,4,6]            // diagonals
];

// Player colour palette (consistent per player ID hash)
const COLORS = ['#e0335c','#7c4dff','#00b0d8','#ff8c00','#3dba6f','#e040fb','#26c6da'];

// ── Helpers ────────────────────────────────────────────────

function getOrCreatePlayerId() {
  let id = localStorage.getItem('bingo_pid');
  if (!id) {
    id = Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem('bingo_pid', id);
  }
  return id;
}

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

// ── Init ───────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {

  // Welcome
  document.getElementById('btn-create').addEventListener('click', createGame);
  document.getElementById('btn-join').addEventListener('click', joinGame);
  document.getElementById('input-name').addEventListener('keydown', e => e.key === 'Enter' && createGame());
  document.getElementById('input-code').addEventListener('keydown', e => e.key === 'Enter' && joinGame());

  // Lobby
  document.getElementById('btn-copy').addEventListener('click', () => {
    navigator.clipboard.writeText(gameId).then(() => showToast('Kód zkopírován!'));
  });
  document.getElementById('btn-add-song').addEventListener('click', addSong);
  document.getElementById('input-song').addEventListener('keydown', e => e.key === 'Enter' && addSong());
  document.getElementById('btn-start').addEventListener('click', startGame);

  // Event delegation for pool remove buttons
  document.getElementById('list-pool').addEventListener('click', e => {
    const btn = e.target.closest('.btn-remove');
    if (btn) removeSong(btn.dataset.song);
  });

  // Card selection
  document.getElementById('btn-confirm').addEventListener('click', confirmCard);

  // Game
  document.getElementById('btn-new-game').addEventListener('click', newGame);

  // Win banner
  document.getElementById('btn-close-banner').addEventListener('click', () => {
    document.getElementById('win-banner').classList.add('hidden');
  });

  // Try to reconnect if returning player
  await tryReconnect();
});

// ── Reconnect ──────────────────────────────────────────────

async function tryReconnect() {
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
  } catch (_) { /* Firebase not yet configured – stay on welcome */ }
}

function clearSave() {
  localStorage.removeItem('bingo_gid');
  localStorage.removeItem('bingo_name');
}

// ── Create / Join ──────────────────────────────────────────

async function createGame() {
  const name = document.getElementById('input-name').value.trim();
  if (!name) { showToast('Zadej své jméno!'); return; }

  playerName = name;
  isHost     = true;
  gameId     = generateCode();

  localStorage.setItem('bingo_gid',  gameId);
  localStorage.setItem('bingo_name', name);

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

  listenToGame();
}

async function joinGame() {
  const name = document.getElementById('input-name').value.trim();
  const code = document.getElementById('input-code').value.trim().toUpperCase();

  if (!name) { showToast('Zadej své jméno!');    return; }
  if (!code) { showToast('Zadej kód hry!');       return; }

  let snap;
  try {
    snap = await db.collection('games').doc(code).get();
  } catch (_) {
    showToast('Chyba připojení k Firebase.'); return;
  }
  if (!snap.exists)                          { showToast('Hra nenalezena.');           return; }
  if (snap.data().status !== 'lobby')        { showToast('Hra již probíhá nebo skončila.'); return; }

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

// ── Lobby actions ──────────────────────────────────────────

async function addSong() {
  const input = document.getElementById('input-song');
  const song  = input.value.trim();
  if (!song)            return;
  if (!currentGame)     return;

  // Duplicate check (case-insensitive)
  const exists = currentGame.pool.some(s => s.toLowerCase() === song.toLowerCase());
  if (exists) { showToast('Tato písnička už je v poolu!'); return; }

  await db.collection('games').doc(gameId).update({
    pool: firebase.firestore.FieldValue.arrayUnion(song)
  });
  input.value = '';
  input.focus();
}

async function removeSong(song) {
  await db.collection('games').doc(gameId).update({
    pool: firebase.firestore.FieldValue.arrayRemove(song)
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
  prevMarked    = [];
  cardSelection = new Set();
  document.getElementById('win-banner').classList.add('hidden');
  showScreen('screen-welcome');
}

// ── Firebase listener ──────────────────────────────────────

function listenToGame() {
  if (unsubscribe) unsubscribe();

  unsubscribe = db.collection('games').doc(gameId).onSnapshot(snap => {
    if (!snap.exists) return;
    const prev  = currentGame;
    currentGame = snap.data();
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

  // Playing or finished
  const me = game.players?.[playerId];

  if (!me?.card) {
    renderCardSelect(game);
    showScreen('screen-select');
  } else {
    renderBoard(game, prev);
    showScreen('screen-game');
  }

  // Win detection: am I the first to notice I've won?
  if (me?.card && !me.hasWon && !game.winner) {
    const win = checkBingo(me.card, game.markedSongs);
    if (win) claimWin();
  }

  // Show win banner when winner appears (or changes)
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
      if (snap.data().winner) return; // someone beat us to it
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

  // Players
  const players = Object.entries(game.players || {});
  document.getElementById('lbl-player-count').textContent = players.length;
  const ul = document.getElementById('list-players');
  ul.innerHTML = '';
  players.forEach(([pid, p]) => {
    const li = document.createElement('li');
    const color = playerColor(pid);
    li.innerHTML = `
      <span class="player-dot" style="background:${color}"></span>
      <span>${esc(p.name)}</span>
      ${pid === game.hostId ? '<span class="host-tag">Host</span>' : ''}
    `;
    ul.appendChild(li);
  });

  // Pool
  const pool = game.pool || [];
  document.getElementById('lbl-pool-count').textContent = pool.length;
  const poolUl = document.getElementById('list-pool');
  poolUl.innerHTML = '';
  pool.forEach(song => {
    const li = document.createElement('li');
    li.innerHTML = `
      <span>${esc(song)}</span>
      ${isHost ? `<button class="btn-remove" data-song="${esc(song)}" title="Odebrat">✕</button>` : ''}
    `;
    poolUl.appendChild(li);
  });

  // Host controls
  const startBtn  = document.getElementById('btn-start');
  const startHint = document.getElementById('lbl-start-hint');
  document.getElementById('host-controls').classList.toggle('hidden', !isHost);
  document.getElementById('player-waiting').classList.toggle('hidden', isHost);

  if (isHost) {
    const enough = pool.length >= 9;
    startBtn.disabled = !enough;
    startBtn.textContent = enough
      ? `Spustit hru (${pool.length} písniček)`
      : `Spustit hru`;
    startHint.textContent = enough
      ? 'Všichni připraveni? Spusť hru!'
      : `Přidej aspoň ${9 - pool.length} dalších písniček.`;
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

  // Header
  document.getElementById('lbl-code-game').textContent    = gameId;
  document.getElementById('lbl-marked-count').textContent = marked.length;
  document.getElementById('lbl-my-name').textContent      = `Tvoje karta – ${playerName}`;

  // My bingo card
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

  // My progress label
  const prog = maxLineProgress(card, marked);
  document.getElementById('lbl-my-progress').textContent = winLine
    ? '🏆 BINGO!'
    : `Nejlepší řada: ${prog} / 3`;

  // Marked songs tags
  const tagsEl = document.getElementById('marked-tags');
  tagsEl.innerHTML = '';
  marked.forEach(song => {
    const span = document.createElement('span');
    span.className = 'marked-tag';
    span.textContent = song;
    tagsEl.appendChild(span);
  });

  // Toast for newly marked songs (by anyone)
  if (prev?.markedSongs) {
    const fresh = marked.filter(s => !prev.markedSongs.includes(s));
    fresh.forEach(s => showToast(`🎵 "${s}" zahrána!`, 2500));
  }

  // Others' cards
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
  const banner  = document.getElementById('win-banner');
  const textEl  = document.getElementById('win-text');
  const confEl  = document.getElementById('confetti');

  textEl.innerHTML = isMe
    ? '<div style="font-size:2rem;margin-bottom:4px">BINGO!</div><div>Vyhrál/a jsi! 🎉</div>'
    : `<div style="font-size:1.6rem;margin-bottom:4px">BINGO!</div><div>${esc(name)} vyhrál/a!</div>`;

  // Confetti pieces
  confEl.innerHTML = '';
  const confColors = ['#e0335c','#7c4dff','#ffd740','#3dba6f','#00b0d8','#ff8c00'];
  for (let i = 0; i < 18; i++) {
    const piece = document.createElement('div');
    piece.className = 'confetti-piece';
    piece.style.cssText = `
      background: ${confColors[i % confColors.length]};
      animation-delay: ${(Math.random() * .6).toFixed(2)}s;
      animation-duration: ${(.5 + Math.random() * .5).toFixed(2)}s;
      transform: rotate(${Math.random() * 360}deg);
    `;
    confEl.appendChild(piece);
  }

  banner.classList.remove('hidden');

  // Auto-close after 7s for non-winner
  if (!isMe) setTimeout(() => banner.classList.add('hidden'), 7000);
}
