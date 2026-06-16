# WalletConnect interop bundle

`wc_interop.src.js` is the hand-written source for the Flutter web app's
WalletConnect glue. It bundles [`@reown/appkit`](https://reown.com) (the same JS
AppKit the React app uses) and exposes a small imperative API on
`window.GeoSafeWC` that the Dart web target drives via `dart:js_interop`. This
gives the Flutter **web** build the exact modal / connect / QR / extension
behaviour of the React app; the Dart `reown_appkit` SDK is only used on the
mobile builds.

## Build

The bundle (`../wc_interop.js`, loaded by `web/index.html`) is **generated and
not committed**. Build it before `flutter build web`:

```bash
cd web/interop
npm ci          # installs @reown/appkit (+ adapter) and esbuild, pinned
npm run build   # esbuild → ../wc_interop.js  (IIFE, browser)
```

Or use the repo-root helper which does both steps + the Flutter build:

```bash
./scripts/build_web.sh --base-href / --dart-define=WALLETCONNECT_PROJECT_ID=<id>
```

CI runs the same `npm ci && npm run build` before the Flutter web build (see
`.github/workflows/web_deploy.yml`).

## Pinning

`@reown/appkit` and `@reown/appkit-adapter-ethers` are pinned to an **exact**
version (`1.8.18`) — the version the bundle was developed and tested against.
`package-lock.json` is committed for reproducible installs. Bump deliberately,
then re-test the connect/sign flows.
