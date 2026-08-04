# Native app build (Capacitor 8)

The web app is unchanged — these are additive. `lib/native.js` gates every
native behavior behind `Capacitor.isNativePlatform()`, so one bundle serves
web, PWA, iOS, and Android.

## Done (platform-independent)

- Capacitor core + CLI, plugins: app, preferences, browser, status-bar, splash-screen
- `capacitor.config.json` — appId `co.motorlog.app`, webDir `dist`,
  CapacitorHttp enabled, night-cockpit splash/status colors
- **NHTSA proxy fix** — `nhtsaBase()` returns the Netlify rewrite on web and
  `https://api.nhtsa.gov` natively (CapacitorHttp bypasses CORS)
- **Auth session storage** — native builds persist the Supabase session in
  OS-backed Preferences instead of WKWebView localStorage (which iOS can evict)
- **Google Drive OAuth** — `oauthRedirect()` points native builds at
  `https://motorlog.netlify.app/gdrive-callback`; an `appUrlOpen` listener
  feeds the returned code into the existing exchange path

## Prerequisites still needed on this Mac

| Need | For | Status |
|---|---|---|
| Node 22+ | Capacitor 8 | ✅ v22.22.2 |
| **Xcode 26+** (App Store, ~7GB) | iOS build/simulator/submit | ❌ only Command Line Tools |
| **JDK 17+** (`brew install openjdk@17`) | Android Gradle | ❌ Java 11 |
| Android Studio + SDK | Android build/emulator | ❌ |

## Next steps once those are installed

```bash
npx cap add ios
npx cap add android
npm run build && npx cap sync
npx cap open ios        # Xcode: signing team, then run on device
```

Then: icons/splash from the PWA assets (`@capacitor/assets`), Info.plist
usage strings (camera, photo library, Bluetooth), Android manifest
permissions + deep-link intent filter, and the two well-known files on
Netlify (`apple-app-site-association`, `assetlinks.json`) for the OAuth
universal link.

## Then BLE (the marquee native feature)

`@capacitor-community/bluetooth-le` + the existing `src/lib/obd.js` protocol
layer, which is transport-agnostic and already covered by 11 tests. Add phone
GPS capture alongside it so the phone supplies position while the dongle
supplies engine data.
