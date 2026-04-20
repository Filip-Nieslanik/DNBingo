# DNBingo

Real-time multiplayer music bingo. Host picks a playlist, players build their own
3×3 cards from the pool, first full line wins. Runs as a static site on top of
Firebase (Auth + Firestore) — no backend to deploy.

Live: <https://filip-nieslanik.github.io/DNBingo/>

## Stack

- Vanilla HTML / CSS / JS — no build step
- Firebase JS SDK 10 (compat) via CDN
  - **Auth** — anonymous for players, email/password for the admin
  - **Firestore** — one document per game, real-time via `onSnapshot`
- GitHub Pages for hosting

## How it works

1. Host creates a game and shares the 6-character code.
2. Everyone joins the lobby, anyone can add songs to the shared pool.
3. Host starts the game once the pool has ≥ 9 songs.
4. Each player picks 9 of those songs for their own card.
5. Host marks songs as they play. First bingo wins (resolved by a Firestore
   transaction so ties can't double-win).

Reconnects survive a refresh via `localStorage` + Auth UID as player ID.

## Project layout

```
index.html          Screens and DOM scaffolding
style.css           Theme (CSS custom properties) and layout
app.js              Game logic, auth, Firestore sync, admin panel
firebase-config.js  Public Firebase project config (apiKey is not a secret)
firestore.rules     Security rules (source of truth, mirror of console)
```

## Local development

Any static server works:

```bash
python -m http.server 8080
# or
npx serve .
```

Open <http://localhost:8080>. Firebase calls go to the real project.

## Admin

Visit `/#admin`. Requires the admin account configured in Firebase Auth
(email/password). Shows active sessions and lets you terminate them.
Concurrency is capped at 3 active games.

## Deploy

`main` auto-deploys to GitHub Pages.

## License

MIT — see [LICENSE](LICENSE).
