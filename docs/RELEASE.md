# Releases

Both the app and the site are released by hand: you run an action with a commit on `main`. Neither has tracks or
pre-releases.

| | Runs | Makes | Where it goes |
| --- | --- | --- | --- |
| App | [Release app](../.github/workflows/app-release.yml) | `.pacman` and AppImage for Linux (x64), `.dmg` and `.zip` for macOS (Apple silicon), and the update feed | A GitHub release, `app-YYYYMMDD.N`, marked latest |
| Site | [Release site](../.github/workflows/site-release.yml) | Nothing: it moves the `site-production` branch | Cloudflare Workers builds it. See [site/DEPLOY.md](../site/DEPLOY.md) |

## The app

### Release it

```bash
gh workflow run app-release.yml -f sha=main      # what's on main now
gh workflow run app-release.yml -f sha=1a2b3c4   # a particular commit on main
```

Or **Actions → Release app → Run workflow**. It refuses a commit that isn't on `main`. It then:

1. Names the release by the UTC date and a count for the day: `20261119.1` is the first release made on 19 November 2026,
   `20261119.2` the second. The count comes from the day's `app-20261119.*` tags.
2. Builds the commit on Linux (`ubuntu-latest`) and macOS (`macos-latest`, Apple silicon) with `npm run build` and electron-builder.
3. Tags the commit `app-20261119.1` and publishes the GitHub release "OMFV 20261119.1" with the files and `SHA256SUMS`, marked latest.
   The notes list the pull requests since the release before. Marking it latest is what makes installed apps update to it: see
   [Updates](#updates).

`dry_run` stops after the builds and keeps the files as the run's artifacts, with no tag and no release. A pull request that
changes the packaging (`electron-builder.yml`, `electron/appFiles.ts`, `package.json`, the lock file or the workflow) builds both
platforms the same way, also without releasing.

electron-builder needs a semver version, so a release's package version is `20261119.1.0`. `shared/release.ts` turns it back into
the name, and `/version` in the palette shows it. Built from a checkout, the app says it isn't a release.

There's no rollback: a release stays published, and a fix is another release. Delete a bad one from GitHub's releases page, with
its tag, so nobody downloads it.

### Install it

| Platform | File | Install |
| --- | --- | --- |
| Omarchy, Arch | `omfv-….pacman` | `sudo pacman -U omfv-20261119.1.0-linux-x64.pacman`. It installs to `/opt/oh-my-f1-viewer`, with `oh-my-f1-viewer` on the path and "OMFV" in the app launcher. `sudo pacman -R oh-my-f1-viewer` removes it |
| Other Linux | `omfv-….AppImage` | `chmod +x` it and run it. It needs FUSE 2 (`fuse2` on Arch, `libfuse2` on Ubuntu) |
| macOS | `omfv-….dmg` | Drag it to Applications. It isn't notarized, so the first time it's opened, macOS refuses: go to **System Settings → Privacy & Security** and choose **Open Anyway**. Or run `xattr -dr com.apple.quarantine /Applications/oh-my-f1-viewer.app` |

The AppImage and the Mac app update themselves from then on: see [Updates](#updates). The pacman package doesn't yet: a newer
release installs over it the same way ([issue 181](https://github.com/natheihei/oh-my-f1-viewer/issues/181) moves it to the AUR).

While the repo is private, downloading a release needs access to the repo, and nothing can update itself.

### Updates

An AppImage or a Mac app that's a release checks for a newer release a minute after it starts, then every 4 hours. It
downloads one in the background and installs it when you quit, so the next start is the new release. There's no command,
it never restarts on its own, and nothing appears over the video. The palette says once `OMFV 20261121.1 is ready. It
automatically installs next time you start oh-my-f1-viewer.` (it's installed as the app quits), and on the next start, `Updated to
OMFV 20261121.1.` `/whats-new` opens that release's notes, and `/version` names a release waiting to install. A release that
didn't install on quit is named in red on the next start, and tried again.
A failed check or download is only logged.

Closing the window quits, on macOS too, where Mac apps usually stay in the dock: an update waits for the app to quit. On macOS the
next start then asks for the keychain password: see [Sign the Mac build](#sign-the-mac-build).

- **The feed.** `publish` in `electron-builder.yml` names `releases/latest/download` on this repo, so the app reads
  `latest-linux.yml` or `latest-mac.yml` from the release marked latest, and electron-builder writes `app-update.yml` into the
  app. There's no GitHub API, so no token or rate limit, but the repo has to be public.
- **The work** is electron-updater's, from `electron/updates.ts`: on Linux it replaces the AppImage file where it is, and on
  macOS Squirrel.Mac swaps the app in `/Applications` from the `.zip`. It only ever moves to a newer release.
- **What's kept between runs**: `update` in `omfv-settings.json`, the release that ran last and the one that was to install on
  quit, so the next start can say which it is now.
- **Not**: the pacman package, a build made by hand (`npm run dist` without a release's version), or a run from source.

### Sign the Mac build

Squirrel.Mac installs an update only if it's signed by the same identity as the running app. An ad-hoc signature is a hash of
the build itself, so no two releases share one. So releases are signed with OMFV's own certificate: self-signed, free, and the
same for every release. Apple doesn't know it, so Gatekeeper still asks once on the first install, as above.

**The keychain still asks after every update.** The entry holding the key to the F1 TV and agent sign-ins, "oh-my-f1-viewer Safe
Storage", has two locks. Its list of allowed apps names the certificate, so every release passes that one. Its partition list
names the build: macOS gives an app signed with a Team ID the partition `teamid:…`, the same for every release, but an app
without one, as ours is, gets `cdhash:…`, the hash of that very build. So the first start of each new release asks for the login
password. **Always Allow** adds that build's hash, and the next release asks again; **Deny** leaves the sign-ins unread. The app
can't add to the list itself, since that needs the password. Only a Developer ID, which carries a Team ID, ends it: see
[Not done yet](#not-done-yet). A run from source is a different build again, so it asks too.

Make it once, from a checkout, with `gh` signed in as someone who can set the repo's secrets:

```bash
scripts/mac-signing-cert.sh ~/omfv-signing.p12
```

It sets `MAC_CERT_P12` and `MAC_CERT_PASSWORD`, which the action signs with, and leaves a copy and its password with you. Keep
both: a new certificate is a new identity, and Macs with OMFV would need the next release installed by hand, once. Without the
secrets the action signs ad-hoc and warns, and those Mac apps don't update themselves. The action checks the signature either
way.

### What packaging changes

- **The name stays `oh-my-f1-viewer`.** Electron names the profile folder after it, and the OS keystore entry that decrypts the saved
  F1 TV and agent logins. So an installed app uses the same profile as a run from the checkout: `~/.config/oh-my-f1-viewer` on Linux,
  `~/Library/Application Support/oh-my-f1-viewer` on macOS. Only one of them runs at a time, as with two runs from source. The
  launcher entry and the macOS dock say "OMFV".
- **`app.asar`.** The app's code, `dist/` and `dist-electron/`, is packed into `resources/app.asar`, with the dependencies.
- **The build agent's files** sit beside it: `resources/dist-types` and `resources/components`. The mods code copies them into the mods
  folder on every start. `electron/appFiles.ts` says where they are, packaged or not.
- **esbuild** compiles mods by spawning its binary, which can't run from inside `app.asar`. It's unpacked into `app.asar.unpacked`, and
  `electron/appFiles.ts` sets `ESBUILD_BINARY_PATH` to it before anything loads esbuild. `main.ts` imports it first for that reason.
- **The developer switches are off** (`electron/vendor/f1ov/devFlags.js`): `ELECTRON_START_URL` and the rest only work unpackaged.
- **Electron is castLabs' build** from `node_modules/electron/dist` (`electronDist`), so each platform is packaged on its own runner.
  The Widevine CDM is downloaded at the first start, into the profile, as it is from source.
- **The pacman package's dependencies** are listed in `electron-builder.yml`: electron-builder's own list names packages Arch no longer
  has.

### Check a build

```bash
npm run dist
```

```bash
node scripts/packaged-check.mjs /tmp/packaged-check
```

```bash
npm run build && node scripts/update-check.mjs /tmp/update-check
```

`npm run dist` builds and packages for the platform you're on, into `release/`, as version `0.1.0` (from `package.json`): pass
`-- -c.extraMetadata.version=20261119.1.0` to name it like a release. `scripts/packaged-check.mjs` runs what it left in
`release/linux-unpacked` or `release/mac-arm64`, or the executable or AppImage named after the folder, on an isolated profile with
copies of both sign-ins. It checks that the app loads from `app.asar`, says it's packaged and which release it is, decrypts both
sign-ins, copies the build agent's files, compiles a mod, has the Widevine CDM, and plays a session.

`scripts/update-check.mjs` updates an AppImage from one release to the next, on Linux: it packages `20261120.1` and `20261120.2`
with a feed on localhost, serves the second, and runs the first on an isolated profile. It checks that the palette says the
second is ready, that quitting puts it in the first's place, and that the next start is the second and says so. The first check
waits a minute, so it takes a few.

### Not done yet

- **A Developer ID on macOS.** The app is signed with OMFV's own certificate, not a Developer ID, and isn't notarized, so
  Gatekeeper asks once, and the keychain asks after every update. A Developer ID (the Apple Developer Program) ends both.
- **VMP on macOS.** castLabs' build carries a development VMP signature. Whether F1 TV's licence server accepts it for DRM streams
  isn't known: most replays aren't encrypted. If it doesn't, the macOS build needs signing through castLabs' EVS (free, with an
  account) before the Apple signature.
- **Intel Macs, Windows and Linux on arm64.**
- **Updates for the pacman package**, through the AUR ([issue 181](https://github.com/natheihei/oh-my-f1-viewer/issues/181)).

## The site

Staging builds every merge to `main`, and **Release site** with a commit moves `site-production` to it, which Workers Builds
deploys. No tags or releases are made. [site/DEPLOY.md](../site/DEPLOY.md) has the whole of it.
