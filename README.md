# Holdem MVP

Phone multiplayer Texas Hold'em for learning and entertainment only. It uses virtual chips only. No real money, top-up, cash-out, exchange, gambling, cash reward, or real benefit flow exists.

## What Exists

```text
server/
  migrations/001_init.sql      # schema reference
  src/auth.ts                  # bcrypt password hash, HS256 JWT, voice token
  src/db.ts                    # SQLite auto migration, users, chip ledger
  src/index.ts                 # HTTP auth API, Socket.IO auth/events/timers
  src/roomStore.ts             # rooms, buy-in/cash-out, voice room state
  src/game/*                   # authoritative poker engine
  test/*.test.ts               # auth, chips, betting, side pot, hand tests
mobile/
  App.tsx                      # login/register/lobby/table UI
  src/api/client.ts            # API timeout/error classification and URL guard
  src/auth/*                   # SecureStore token storage with AsyncStorage migration
  src/utils/*                  # amount parsing and error dedupe
  app.json                     # Android package/config
  src/components/CardView.tsx
scripts/check-android-signature.mjs
scripts/verify-android-release.mjs
eas.json                       # APK preview build profile
.env.example
```

The server is authoritative. The app never deals cards, settles pots, changes chips, or receives opponents' hole cards before showdown.

## Database Migration

Runtime auto-migration runs when the server starts. Applied versions are recorded in the `schema_migrations` table. The same schema is recorded in:

```text
server/migrations/001_init.sql
```

SQLite default:

```text
data/holdem.db
```

Override it:

```bat
set DATABASE_PATH=./data/holdem.db
```

Production must use a durable SQLite file. The server refuses `:memory:` and `/tmp/*` when `NODE_ENV=production`.

Tables:

- `users`: username, bcrypt password hash, nickname, avatar URL/code, persisted bank chips.
- `chip_transactions`: signed ledger rows for buy-in, cash-out, win/loss, admin adjustment.

Backup:

```bash
sqlite3 /var/data/holdem.db ".backup '/var/data/holdem-backup.db'"
```

Restore:

```bash
cp /var/data/holdem-backup.db /var/data/holdem.db
```

For Render, attach a persistent disk mounted at `/var/data` before using `DATABASE_PATH=/var/data/holdem.db`. Do not use `/tmp/holdem.db` for production data.

## Backend

```bash
cd E:/Git/texas-holdem-mobile
npm ci
set JWT_SECRET=replace-with-a-long-random-secret
set DATABASE_PATH=./data/holdem.db
npm run dev:server
```

Auth API:

```text
POST /auth/register
POST /auth/login
GET  /auth/me
```

Socket.IO requires:

```js
auth: { token: "JWT" }
```

Current HTTP auth and Socket clients must send `clientBuild >= MIN_CLIENT_BUILD`. Keep `MIN_CLIENT_BUILD=2` until the build 3 APK is verified and downloadable:

```js
auth: { token: "JWT", clientBuild: 3 }
```

## Render Deploy

This repo includes `render.yaml`. On Render use:

```text
Build Command: npm ci
Start Command: npm start
Node: 24.x
```

Set env vars like this:

```text
NODE_ENV=production
JWT_SECRET=<long-random-secret>
DATABASE_PATH=/var/data/holdem.db
CORS_ORIGIN=https://git-okami.onrender.com
SOCKET_CORS_ORIGIN=https://git-okami.onrender.com
DEFAULT_CHIPS=10000
DEFAULT_SMALL_BLIND=50
DEFAULT_BIG_BLIND=100
DEFAULT_MIN_BUY_IN=1000
DEFAULT_MAX_BUY_IN=10000
DEFAULT_MAX_PLAYERS=6
DEFAULT_ACTION_TIMEOUT_SECONDS=30
MIN_CLIENT_BUILD=2
LATEST_CLIENT_VERSION=1.0.2
CLIENT_DOWNLOAD_URL=
EXPO_PUBLIC_ALLOWED_DOWNLOAD_HOSTS=git-okami.onrender.com,github.com,github-releases.githubusercontent.com,objects.githubusercontent.com
VOICE_PROVIDER=none
```

Do not set `DATABASE_PATH=DATABASE_PATH=...`. Do not use a Windows path such as `E:\Git\...` on Render.

`/tmp/holdem.db` is blocked in production because it is not durable across restarts. Use a Render persistent disk with a Linux path like `/var/data/holdem.db`, or migrate to PostgreSQL before production traffic depends on persisted chips.

`MIN_CLIENT_BUILD=2` is a local development default. In `NODE_ENV=production`, the server refuses to start unless `MIN_CLIENT_BUILD` is explicitly set to a valid non-negative integer. The Render Blueprint leaves this value as `sync: false`; set it manually in the Render Dashboard.

Client upgrade rollout:

1. Build the new APK.
2. Verify the new APK locally and on a phone.
3. Put the APK at a real `CLIENT_DOWNLOAD_URL`.
   If that URL is not on GitHub or `git-okami.onrender.com`, include its host in `EXPO_PUBLIC_ALLOWED_DOWNLOAD_HOSTS` before building the APK.
4. Deploy the server while `MIN_CLIENT_BUILD` still allows the old build.
5. Verify build 3 can register, log in, connect Socket, and finish a minimal hand.
6. Raise `MIN_CLIENT_BUILD` to `3`.
7. Roll back by lowering `MIN_CLIENT_BUILD` to `2` if users cannot upgrade.

## Frontend

```bash
cd E:/Git/texas-holdem-mobile
set EXPO_PUBLIC_API_BASE_URL=http://10.0.2.2:4000
set EXPO_PUBLIC_SOCKET_URL=http://10.0.2.2:4000
npm run dev:mobile
```

Android emulator default URL:

```text
http://10.0.2.2:4000
```

Real phones on the same Wi-Fi should use your computer LAN IP:

```text
http://192.168.1.23:4000
```

## Two-Phone Test

1. Start backend.
2. Start Expo.
3. Phone A registers/logs in.
4. Phone B registers/logs in.
5. Phone A creates a table.
6. Phone B joins the table.
7. Both choose a buy-in, sit, and ready.
8. Owner starts the hand.
9. Play fold/check/call/bet/raise/all-in.
10. Stand or leave the room to cash table chips back to bank chips.

## Tests

```bash
npm test
npm run typecheck
npm run check
```

Current tests cover:

- Register/login/token validation.
- Password hash is not stored in plaintext.
- Token-authenticated user lookup.
- Bank chip persistence.
- Buy-in and cash-out ledger.
- Per-hand win/loss ledger.
- No-limit, pot-limit, fixed-limit betting checks.
- Minimum raise and short all-in.
- Timeout auto fold/check.
- Showdown hand ranking and side pots.
- Mobile token migration, API error classification, amount parsing, error dedupe.
- Duplicate Socket operation ID handling.

## Voice

Voice is disabled in the mobile UI. The previous UI only toggled room state and did not capture, transmit, subscribe, or play audio, so the `RECORD_AUDIO` permission was removed. Add LiveKit/Agora/WebRTC in a development build before exposing voice again.

## APK Build

Install/login/init:

```bash
npm install -g eas-cli
eas login
cd E:/Git/texas-holdem-mobile
eas init
```

Set production URLs in `eas.json` or with EAS secrets:

```bash
eas secret:create --scope project --name EXPO_PUBLIC_API_BASE_URL --value https://your-api.example.com
eas secret:create --scope project --name EXPO_PUBLIC_SOCKET_URL --value https://your-api.example.com
```

This repo's `preview` and `production` EAS profiles currently point to:

```text
https://git-okami.onrender.com
```

Build APK:

```bash
npm run build:apk
```

Download the APK from the EAS build link, copy it to the desktop, then push it to the phone Download directory:

```bash
adb push C:\Users\LWW\Desktop\git-okami-release.apk /sdcard/Download/git-okami-release.apk
```

If EAS is not logged in:

```bash
eas login
npm run build:apk
```

On Windows, if EAS reports an `EXDEV` rename error, run it with a local app-data directory:

```powershell
$env:APPDATA="$PWD/.eas-appdata"
npm run build:apk
```

Android package:

```text
com.fengluo298.gitokami
```

### Local Android Build

Debug APK:

```powershell
cd E:/Git/texas-holdem-mobile/mobile/android
$env:JAVA_HOME='C:\Program Files\Microsoft\jdk-17.0.19.10-hotspot'
$env:ANDROID_HOME='E:\Android\Sdk'
$env:ANDROID_SDK_ROOT=$env:ANDROID_HOME
.\gradlew.bat assembleDebug --no-daemon
```

Release APK/AAB require a real signing key. Do not commit the keystore or passwords.

```powershell
$env:ANDROID_RELEASE_STORE_FILE='C:\secure\release.keystore'
$env:ANDROID_RELEASE_STORE_PASSWORD='<secret>'
$env:ANDROID_RELEASE_KEY_ALIAS='<alias>'
$env:ANDROID_RELEASE_KEY_PASSWORD='<secret>'
.\gradlew.bat assembleRelease --no-daemon
.\gradlew.bat bundleRelease --no-daemon
```

If those variables are missing, release builds fail instead of using the debug keystore.

Check a signed artifact:

```powershell
npm run check:android-signature -- mobile/android/app/build/outputs/apk/release/app-release.apk
npm run verify:android-release -- mobile/android/app/build/outputs/apk/release/app-release.apk
```

The release verification checks signature, package, version, `assets/index.android.bundle`, `debuggable=false`, cleartext traffic, and obvious secret/test file names.

Current Android permissions are limited to network access plus AndroidX's app-private dynamic receiver permission. App data backup is disabled so auth tokens in SecureStore are not backed up.

## Environment

Copy and edit:

```bash
copy .env.example .env.development
```

Important variables:

```text
API_BASE_URL
SOCKET_URL
JWT_SECRET
DATABASE_PATH
VOICE_APP_ID
VOICE_APP_SECRET
EXPO_PUBLIC_API_BASE_URL
EXPO_PUBLIC_SOCKET_URL
EXPO_PUBLIC_ALLOWED_HOSTS
MIN_CLIENT_BUILD
```

## Current Limits

- Rooms are still in memory; restart clears active tables but not users/chip ledger.
- Production persistence still depends on a durable SQLite disk. PostgreSQL migration is the next step before multi-instance or higher availability deployment.
- Real audio transport is not wired yet; mobile voice is intentionally disabled.
- No admin UI.
- No production Redis/session clustering.
- No ESLint config existed in the project; `npm run typecheck` is the current static gate.
