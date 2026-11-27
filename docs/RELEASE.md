# Releases

Both the app and the site are released by hand: you run an action with a commit on `main`. Neither has tracks or
pre-releases.

| | Runs | Makes | Where it goes |
| --- | --- | --- | --- |
| App | [Release app](../.github/workflows/app-release.yml) | `.pacman` and AppImage for Linux (x64), `.dmg` and `.zip` for macOS (Apple silicon), the installer `.exe` for Windows (x64), and the update feed | A GitHub release, `app-YYYYMMDD.N`, marked latest |
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
2. Builds the commit on Linux (`ubuntu-latest`), macOS (`macos-latest`, Apple silicon) and Windows (`windows-latest`, x64)
   with `npm run build` and electron-builder.
3. Tags the commit `app-20261119.1` and publishes the GitHub release "OMFV 20261119.1" with the files and `SHA256SUMS`, marked latest.
   The notes list the pull requests since the release before. Marking it latest is what makes installed apps update to it: see
   [Updates](#updates).

`dry_run` stops after the builds and keeps the files as the run's artifacts, with no tag and no release. `notes` is Markdown put
before the generated notes, for what a release needs done by hand. A pull request that changes the packaging
(`electron-builder.yml`, `build/`, `electron/appFiles.ts`, `electron/updates.ts`, `scripts/packaged-check.mjs`,
`package.json`, the lock file or the workflow) builds every platform the same way, also without releasing.

electron-builder needs a semver version, so a release's package version is `20261119.1.0`. `shared/release.ts` turns it back into
the name, and `/version` in the palette shows it. Built from a checkout, the app says it isn't a release.

There's no rollback: a release stays published, and a fix is another release. Delete a bad one from GitHub's releases page, with
its tag, so nobody downloads it.

### Install it

| Platform | File | Install |
| --- | --- | --- |
| Omarchy, Arch | `omfv-….pacman` | `sudo pacman -U omfv-20261119.1.0-linux-x64.pacman`. It installs to `/opt/oh-my-f1-viewer`, with `oh-my-f1-viewer` on the path and "OMFV" in the app launcher. `sudo pacman -R oh-my-f1-viewer` removes it |
| Other Linux | `omfv-….AppImage` | `chmod +x` it and run it. It needs FUSE 2 (`fuse2` on Arch, `libfuse2` on Ubuntu) |
| macOS | `omfv-….dmg` | Drag it to Applications. It's signed with OMFV's Developer ID and notarized, so it opens like any other download |
| Windows | `omfv-….exe` | Run it. It installs for you alone, into `%LOCALAPPDATA%\Programs\oh-my-f1-viewer`, with no admin prompt, and adds "OMFV" to the Start menu and the desktop. It isn't Authenticode-signed yet, so SmartScreen warns the first time: **More info → Run anyway**. Remove it from **Settings → Apps** |

The AppImage, the Mac app and the Windows app update themselves from then on: see [Updates](#updates). The pacman package doesn't yet: a newer
release installs over it the same way ([issue 181](https://github.com/natheihei/oh-my-f1-viewer/issues/181) moves it to the AUR).

The site's [download page](https://oh-my-f1-viewer.yueyao.run/download) links each of these from the release marked latest.

### Updates

An AppImage, a Mac app or a Windows app that's a release checks for a newer release 5 seconds after it starts, then every 10 minutes. It
downloads one in the background and installs it when you quit, so the next start is the new release. There's no command,
it never restarts on its own, and nothing appears over the video. The palette says once `OMFV 20261121.1 is ready.` with a one-click `restart to update` button beside it (it also installs automatically when the app quits), and on the next start, `Updated to
OMFV 20261121.1.` `/whats-new` opens that release's notes, and `/version` names a release waiting to install with the same `restart to update` button. A release that
didn't install on quit is named in red on the next start, and tried again.
A failed check or download is only logged.

Closing the window quits, on macOS too, where Mac apps usually stay in the dock: an update waits for the app to quit.

- **The feed.** `publish` in `electron-builder.yml` names `releases/latest/download` on this repo, so the app reads
  `latest-linux.yml`, `latest-mac.yml` or `latest.yml` (Windows) from the release marked latest, and electron-builder writes `app-update.yml` into the
  app. There's no GitHub API, so no token or rate limit, but the repo has to be public.
- **The work** is electron-updater's, from `electron/updates.ts`: on Linux it replaces the AppImage file where it is, on
  macOS Squirrel.Mac swaps the app in `/Applications` from the `.zip`, and on Windows it runs the new release's installer,
  silently, as the app quits. It only ever moves to a newer release. Not verified on Windows yet.
- **Squirrel.Mac#331 local patch (macOS).** `build/after-pack.js` runs `build/patch-squirrel-shipit.js` before VMP and
  Apple signing to rebuild `Squirrel.framework/Versions/A/Resources/ShipIt` with `build/patches/squirrel-mac-331.patch`
  ([Squirrel/Squirrel.Mac#331](https://github.com/Squirrel/Squirrel.Mac/pull/331)), so ShipIt removes its own `launchd`
  job once an update finishes instead of leaving a lingering "Running in the background" item in the macOS Dock after
  quit. Remove the patch and script once our Electron version includes Squirrel.Mac#331.
- **What's kept between runs**: `update` in `omfv-settings.json`, the release that ran last and the one that was to install on
  quit, so the next start can say which it is now.
- **Not**: the pacman package, a build made by hand (`npm run dist` without a release's version), a Windows app run from
  `win-unpacked` rather than installed, or a run from source.

### Usage counts

A release sends anonymous usage counts to PostHog: see [TELEMETRY.md](TELEMETRY.md). The **Package** step adds the PostHog
project's key as `-c.extraMetadata.omfvPosthogKey`, from the repo secret `POSTHOG_KEY`, and only when it's run by hand and isn't a
dry run. Without the secret, a release sends nothing. Set it with `gh secret set POSTHOG_KEY`.

### Sign the Mac build

A release's Mac app is signed with OMFV's **Developer ID Application** certificate, under the hardened runtime, and notarized by
Apple, with the ticket stapled to it. That does three things:

- **Updates install.** Squirrel.Mac installs an update only if it's signed by the same identity as the running app. A Developer
  ID's designated requirement names the Team ID, which is the same for every release.
- **The keychain doesn't ask.** The entry holding the key to the F1 TV and agent sign-ins, "oh-my-f1-viewer Safe Storage", has a
  partition list that macOS sets from the app that made it: `teamid:<team>` for an app signed with a Team ID, which every
  release passes. Without one it's `cdhash:<hash>`, that very build, so each release had to ask for the login password.
- **Gatekeeper opens it.** A notarized app opens from a download with no **Open Anyway** step.

`build/entitlements.mac.plist` is what the app and its helpers may do under the hardened runtime: `allow-jit` and
`allow-unsigned-executable-memory` for V8, and `disable-library-validation` for the Widevine CDM, which is downloaded into the
profile at the first start and signed by Google, not by OMFV's team.

The action signs and notarizes through electron-builder, which imports the certificate into a keychain of its own, signs as the
identity with the Team ID in its name, and sends the app to Apple's notary service with an App Store Connect API key. It then
checks the result: the signature verifies, the designated requirement names the Team ID, the hardened runtime is on, and the app
in the `.dmg` has its ticket and is accepted by Gatekeeper as "Notarized Developer ID". A release refuses to run without the
secrets below, since an ad-hoc build is a new identity that installed apps won't update to. A dry run without them signs ad-hoc
and warns. A pull request's build never gets them (see [Who can sign](#who-can-sign)) and always signs ad-hoc, and so does
`npm run dist` on your own Mac.

#### Set it up

Once, by the Apple Developer Program's account holder:

1. **The certificate.** In Xcode, **Settings → Accounts**, pick the team, **Manage Certificates… → + → Developer ID
   Application**. Or make it at [developer.apple.com](https://developer.apple.com/account/resources/certificates/list) from a
   signing request made in Keychain Access. Then in Keychain Access, under **My Certificates**, export "Developer ID Application:
   … (TEAMID)" with its key as a `.p12`, with a password.
2. **The Team ID**, ten characters, from **Membership details** on [developer.apple.com](https://developer.apple.com/account).
3. **A notary key.** In [App Store Connect](https://appstoreconnect.apple.com/access/integrations/api), **Users and Access →
   Integrations → App Store Connect API → Team Keys**, make a key with the **Developer** role. Download its `AuthKey_….p8`,
   which can only be downloaded once, and note its Key ID and the Issuer ID above the list.
4. **The secrets**, in the `mac-signing` environment, not the repo's own secrets. From a checkout with `gh` signed in as the
   repo's owner, or in **Settings → Environments → mac-signing → Add environment secret**:

```bash
base64 -i ~/omfv-developer-id.p12 | gh secret set MAC_DEVELOPER_ID_P12 --env mac-signing
gh secret set MAC_DEVELOPER_ID_PASSWORD --env mac-signing    # asks for the .p12's password
gh secret set APPLE_TEAM_ID --env mac-signing --body ABCDE12345
gh secret set APPLE_API_KEY_P8 --env mac-signing < ~/AuthKey_ABC123DEFG.p8
gh secret set APPLE_API_KEY_ID --env mac-signing --body ABC123DEFG
gh secret set APPLE_API_ISSUER --env mac-signing --body 01234567-89ab-cdef-0123-456789abcdef
```

Keep the `.p12` and the `.p8` somewhere safe, like a password manager. A Developer ID certificate lasts five years; a new one
from the same team keeps the Team ID, so installed apps still update.

Then check it with a dry run, which signs and notarizes as a release would. Its Mac build waits for you to approve it, as
below:

```bash
gh workflow run app-release.yml -f sha=main -f dry_run=true
```

#### Who can sign

A Developer ID signs as OMFV's team, and Apple vouches for whatever it signs, so the certificate and the notary key are kept
from everything but a release:

- **The `mac-signing` environment** holds them, and **`windows-signing`** holds the EVS account for the Windows build. Only a
  run of the action from `main` can use either, and only the Mac build of a release or dry run asks for the first, and the
  Windows build for the second. Each build then waits, with **Review deployments** on the run's page, until the owner
  approves it. A pull request's build asks for neither, so no pull request, from a fork or not, ever has the secrets.
- **The ruleset on `main`** ("Protect main") stops `main` from being deleted or force-pushed, and has everything reach it
  through a pull request. The owner can bypass it.

Anyone given write access can still push a branch and run the action from it, but not from `main` without a pull request, and
not with the secrets without the owner's approval. Before giving someone write access, raise the ruleset's required approvals
from 0 to 1, so their pull requests need the owner's review too, and check each **Review deployments** request before approving
it: approve only runs you started.

#### VMP-sign the app

castLabs' Electron comes with a development VMP signature, which says who built the browser the Widevine CDM runs in. F1 TV's
licence server refuses it on macOS and Windows for a DRM stream, which every live session is: "Widevine license generation failed
(DEVELOPMENT_CERTIFICATE_NOT_ALLOWED)". Seen on 2026 Las Vegas qualifying. Most replays aren't encrypted and play anyway, and
Linux has no VMP.

castLabs' [EVS](https://github.com/castlabs/electron-releases/wiki/EVS) signs it for production, free, with an account.
`build/vmp-sign.js` does it, and then verifies it:

- **The Mac app** as electron-builder's `afterPack`, since the Apple signature has to come after and seal it.
- **The Windows app** as its `afterSign`, through `build/vmp-sign-win.js`. The signature is `oh-my-f1-viewer.exe.sig` beside the
  `.exe`, made from the `.exe` as it is, so it has to come after electron-builder edits the `.exe`'s icon and details (and after
  an Authenticode signature, once there is one). electron-builder skips `afterSign` when it doesn't edit the `.exe`
  (`-c.win.signAndEditExecutable=false`), so such a build isn't VMP-signed.

It signs as `EVS_ACCOUNT_NAME` and `EVS_PASSWD`, or as the account last signed in on the machine. Without either it warns and
packages the app unsigned, as a pull request's build and a dry run without the secrets do. A release refuses. The Mac build
gets the account from the `mac-signing` environment and the Windows build from `windows-signing`, which is set up the same way:
only `main` can use it, and each run waits for the owner under **Review deployments**.

Once, by the owner:

```bash
python3 -m pip install --user --upgrade castlabs-evs
python3 -m castlabs_evs.account signup    # asks for an email, a name, an account name and a password, then the emailed code
gh secret set EVS_ACCOUNT_NAME --env mac-signing        # asks for the account name
gh secret set EVS_PASSWD --env mac-signing              # asks for the password
gh secret set EVS_ACCOUNT_NAME --env windows-signing    # the same account again: a secret can't be read back to copy it
gh secret set EVS_PASSWD --env windows-signing
```

After `signup`, or `python3 -m castlabs_evs.account reauth` on another machine, `npm run dist` there VMP-signs too. A run from source
needs its own Electron signed, again after each `node node_modules/electron/install.js`:

```bash
npm run vmp:sign
```

#### Moving installed Macs over

Releases up to the first Developer ID one were signed with OMFV's own self-signed certificate, so a Mac with one of those won't
update itself to it: each start downloads it, and the install on quit fails. Install that release by hand, once, from its `.dmg`.
Its first start may ask for the keychain password once more, and **Always Allow** adds it; releases after it shouldn't ask. Say
so in its notes:

```bash
gh workflow run app-release.yml -f sha=main -f notes='**On a Mac with an earlier release, install this one by hand from its .dmg.** It is the first signed with a Developer ID, and earlier releases cannot update to it themselves.'
```

The old repo secrets, `MAC_CERT_P12` and `MAC_CERT_PASSWORD`, aren't read any more:

```bash
gh secret delete MAC_CERT_P12
gh secret delete MAC_CERT_PASSWORD
```

### What packaging changes

- **The name stays `oh-my-f1-viewer`.** Electron names the profile folder after it, and the OS keystore entry that decrypts the saved
  F1 TV and agent logins. So an installed app uses the same profile as a run from the checkout: `~/.config/oh-my-f1-viewer` on Linux,
  `~/Library/Application Support/oh-my-f1-viewer` on macOS, `%APPDATA%\oh-my-f1-viewer` on Windows. Only one of them runs at a time, as with two runs from source. The
  launcher entry and the macOS dock say "OMFV".
- **`app.asar`.** The app's code, `dist/` and `dist-electron/`, is packed into `resources/app.asar`, with the dependencies.
- **The build agent's files** sit beside it: `resources/dist-types` and `resources/components`. The mods code copies them into the mods
  folder on every start. `electron/appFiles.ts` says where they are, packaged or not.
- **esbuild** compiles mods by spawning its binary, which can't run from inside `app.asar`. It's unpacked into `app.asar.unpacked`, and
  `electron/appFiles.ts` sets `ESBUILD_BINARY_PATH` to it before anything loads esbuild: `bin/esbuild` in its package, or
  `esbuild.exe` on Windows. `main.ts` imports it first for that reason.
- **The developer switches are off** (`electron/vendor/f1ov/devFlags.js`): `ELECTRON_START_URL` and the rest only work unpackaged.
- **Electron is castLabs' build** from `node_modules/electron/dist` (`electronDist`), so each platform is packaged on its own runner.
  The Widevine CDM is downloaded at the first start, into the profile, as it is from source. The Mac and Windows apps are
  VMP-signed for it:
  see [VMP-sign the app](#vmp-sign-the-app).
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
`release/linux-unpacked`, `release/mac-arm64` or `release/win-unpacked`, or the executable or AppImage named after the folder,
on an isolated profile with copies of both sign-ins. It checks that the app loads from `app.asar`, says it's packaged and which release it is, decrypts both
sign-ins, copies the build agent's files, compiles a mod, has the Widevine CDM, and plays a session.

A Windows build is made on Windows: `npm run dist` there, after `node node_modules/electron/install.js` has put castLabs'
Windows Electron in `node_modules/electron/dist`. From Linux, `npx electron-builder --win` needs that Electron unzipped
somewhere else and named with `-c.electronDist=`, `@esbuild/win32-x64` in `node_modules`, and Wine, which edits the `.exe` and
makes the installer. Without Wine, `--win dir -c.win.signAndEditExecutable=false` makes only `release/win-unpacked`, with no
icon and not VMP-signed. `castlabs_evs.vmp sign-pkg release/win-unpacked` signs it, and the folder runs zipped, without
installing.

`scripts/update-check.mjs` updates an AppImage from one release to the next, on Linux: it packages `20261120.1` and `20261120.2`
with a feed on localhost, serves the second, and runs the first on an isolated profile. It checks that the palette says the
second is ready, that quitting puts it in the first's place, and that the next start is the second and says so.

### Not done yet

- **A VMP-signed release.** The signing and the EVS secrets are in place, but no release has been made with it: see
  [VMP-sign the app](#vmp-sign-the-app) and [issue 174](https://github.com/natheihei/oh-my-f1-viewer/issues/174).
- **A Windows release.** The action builds the installer, but none has been released, installed from GitHub or updated.
- **Authenticode-signing the Windows app,** so SmartScreen doesn't warn. It needs a code-signing certificate.
- **Intel Macs, Windows on arm64 and Linux on arm64.**
- **Updates for the pacman package**, through the AUR ([issue 181](https://github.com/natheihei/oh-my-f1-viewer/issues/181)).

## The site

Staging builds every merge to `main`, and **Release site** with a commit moves `site-production` to it, which Workers Builds
deploys. No tags or releases are made. [site/DEPLOY.md](../site/DEPLOY.md) has the whole of it.
