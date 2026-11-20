# Releases

Both the app and the site are released by hand: you run an action with a commit on `main`. Neither has tracks or
pre-releases.

| | Runs | Makes | Where it goes |
| --- | --- | --- | --- |
| App | [Release app](../.github/workflows/app-release.yml) | `.pacman` and AppImage for Linux (x64), `.dmg` for macOS (Apple silicon) | A GitHub release, `app-YYYYMMDD.N` |
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
   The notes list the pull requests since the release before.

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

A newer release installs over an older one the same way. Nothing updates itself yet.

While the repo is private, downloading a release needs access to the repo.

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

`npm run dist` builds and packages for the platform you're on, into `release/`, as version `0.1.0` (from `package.json`): pass
`-- -c.extraMetadata.version=20261119.1.0` to name it like a release. `scripts/packaged-check.mjs` runs what it left in
`release/linux-unpacked` or `release/mac-arm64`, or the executable or AppImage named after the folder, on an isolated profile with
copies of both sign-ins. It checks that the app loads from `app.asar`, says it's packaged and which release it is, decrypts both
sign-ins, copies the build agent's files, compiles a mod, has the Widevine CDM, and plays a session.

### Not done yet

- **Signing on macOS.** The app is signed ad-hoc, not with a Developer ID, and not notarized. Gatekeeper asks once, and auto-update
  would need a real signature.
- **VMP on macOS.** castLabs' build carries a development VMP signature. Whether F1 TV's licence server accepts it for DRM streams
  isn't known: most replays aren't encrypted. If it doesn't, the macOS build needs signing through castLabs' EVS (free, with an
  account) before the Apple signature.
- **Intel Macs, Windows and Linux on arm64.**
- **Auto-update** ([issue 171](https://github.com/natheihei/oh-my-f1-viewer/issues/171)). It would read from these releases, and
  needs the macOS build signed.

## The site

Staging builds every merge to `main`, and **Release site** with a commit moves `site-production` to it, which Workers Builds
deploys. No tags or releases are made. [site/DEPLOY.md](../site/DEPLOY.md) has the whole of it.
