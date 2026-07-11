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
eas.json                       # APK preview build profile
.env.example
.env.development
.env.production
```

The server is authoritative. The app never deals cards, settles pots, changes chips, or receives opponents' hole cards before showdown.

## Database Migration

Runtime auto-migration runs when the server starts. The same schema is recorded in:

```text
server/migrations/001_init.sql
```

SQLite default:

```text
data/holdem.db
```

Override it:

```bat
set DATABASE_URL=./data/holdem.db
```

Tables:

- `users`: username, bcrypt password hash, nickname, avatar URL/code, persisted bank chips.
- `chip_transactions`: signed ledger rows for buy-in, cash-out, win/loss, admin adjustment.

## Backend

```bash
cd E:/Git/texas-holdem-mobile
npm install
set JWT_SECRET=replace-with-a-long-random-secret
set DATABASE_URL=./data/holdem.db
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

Current Socket clients must also send `clientBuild >= MIN_CLIENT_BUILD`:

```js
auth: { token: "JWT", clientBuild: 2 }
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
DATABASE_URL=/tmp/holdem.db
CORS_ORIGIN=*
SOCKET_CORS_ORIGIN=*
DEFAULT_CHIPS=10000
DEFAULT_SMALL_BLIND=50
DEFAULT_BIG_BLIND=100
DEFAULT_MIN_BUY_IN=1000
DEFAULT_MAX_BUY_IN=10000
DEFAULT_MAX_PLAYERS=6
DEFAULT_ACTION_TIMEOUT_SECONDS=30
MIN_CLIENT_BUILD=2
VOICE_PROVIDER=none
```

Do not set `DATABASE_URL=DATABASE_URL=...`. Do not use a Windows path such as `E:\Git\...` on Render.

`/tmp/holdem.db` is enough to start the service on Render's free plan, but it is not durable across restarts. Use a paid Render disk with a Linux path like `/var/data/holdem.db`, or migrate to PostgreSQL, when persistent chips matter.

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

Download the APK from the EAS build link, then install:

```bash
adb install path/to/app.apk
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
```

The check fails when the certificate subject contains `Android Debug`.

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
DATABASE_URL
VOICE_APP_ID
VOICE_APP_SECRET
EXPO_PUBLIC_API_BASE_URL
EXPO_PUBLIC_SOCKET_URL
EXPO_PUBLIC_ALLOWED_HOSTS
MIN_CLIENT_BUILD
```

## Current Limits

- Rooms are still in memory; restart clears active tables but not users/chip ledger.
- Real audio transport is not wired yet; mobile voice is intentionally disabled.
- No admin UI.
- No production Redis/session clustering.
- No ESLint config existed in the project; `npm run typecheck` is the current static gate.
