# NHL Standings Predictor

Predict the final regular-season standings, join a league of up to 12 players, and lock in your picks before the season starts. Static site (GitHub Pages) plus a free Supabase backend.

```
index.html          page shell
styles.css          styles
app.js              all app logic
config.js           your Supabase URL + public key (safe to commit)
supabase/schema.sql database tables, security rules, and server-side functions
```

## One-time setup

### 1. Create the Supabase project
1. Sign up at supabase.com and create a free project.
2. Open **SQL Editor > New query**, paste all of `supabase/schema.sql`, and run it. It is safe to re-run after edits.
3. Open **Project Settings > API** and copy the **Project URL** and the **anon / publishable key** into `config.js`. Both are public by design; the database rules are what protect the data. Never put the `service_role` / secret key anywhere in this repo.

### 2. Set up Google sign-in
1. In Google Cloud Console, create a project, then go to **APIs & Services > OAuth consent screen** (Google Auth Platform). Choose **External**, fill in the app name and your email, and keep the default scopes (email, profile, openid).
2. **Publish the app** ("In production"). While it is in "Testing", only accounts you list by hand can sign in. The default scopes need no Google verification.
3. Go to **Credentials > Create credentials > OAuth client ID > Web application**. Under **Authorized redirect URIs**, add `https://YOUR-PROJECT-REF.supabase.co/auth/v1/callback`. (Supabase shows this exact URL under **Authentication > Sign In / Providers > Google**.)
4. Copy the client ID and secret into that same Supabase Google provider page and enable it.

### 3. Tell Supabase where the site lives
**Authentication > URL Configuration**
- **Site URL:** `https://YOUR-USERNAME.github.io/YOUR-REPO/`
- **Redirect URLs:** add the same URL, plus `http://localhost:8000/` for local testing.

### 4. Deploy
Commit and push. GitHub Pages redeploys automatically.

## Run locally
```
python -m http.server 8000
```
Then open `http://localhost:8000/` (use `localhost`, not `127.0.0.1`, so it matches the redirect URL above).

## Rules enforced by the database
Every write goes through a server-side function, so the browser cannot bypass any of these:
- A league holds at most 12 players.
- Each player has one submission per season. Once submitted it cannot be changed or deleted.
- Submissions are rejected after `picks_close_at` in the `seasons` table (set to first puck drop, Sept 29, 2026, 5:00 p.m. ET).
- Picks are validated: all 32 teams, whole-number points from 0 to 168, each position 1 to 8 used once per division, and a league total between 2,688 and 4,032.
- Other players' picks are hidden until picks close, and then only visible to people in a shared league.

## Keeping things in sync
The team list appears in two places: `LEAGUE` in `app.js` and the `teams` table in `schema.sql`. If the NHL changes divisions or adds a team, update both. Season length and the deadline live in the `seasons` table; the matching `GAMES` constant is at the top of `app.js`.

## Notes
- Free Supabase projects pause after about a week without activity. Resume from the dashboard if that happens.
- Not built yet: leaving or deleting a league, results entry, scoring, and a leaderboard. The scoring functions in `app.js` are ready for it.
