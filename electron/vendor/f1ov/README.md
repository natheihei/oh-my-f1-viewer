# Vendored from F1 OpenViewer

These modules come from [F1 OpenViewer](https://github.com/npanu420/F1OpenViewer) (MIT, see `LICENSE`) at
commit `6607ead`. They hold hard-won behaviour for F1 TV sign-in, entitlement, DRM licensing and timing, so
they stay as close to upstream as possible and are wrapped rather than rewritten. Code the app doesn't call stays too, such as
the replay functions in `livetiming.js`, so that updates from upstream are easy to merge.

Local changes:

- `session.js`: profile file names use `omfv-` instead of `f1openviewer-`.
- `secureStore.js`, `session.js`: use the async `safeStorage` methods, since Electron 45 deprecates the sync ones and 46 removes them.
  Writes and removals of a file are queued in call order, so a slow encrypt can't let older text overwrite newer, and the
  persistence functions are async.
- `secureStore.js`: the file is written readable only by its user (0600), so a plain-text one, without a keystore, is never readable by others.
- `livetiming.js`: the User-Agent for the public sync API says `oh-my-f1-viewer`. Live records carry the feed's timestamp and mark a snapshot, and `fetchSessionFeedText` is new, all for the session database.
- `liveConnection.js`: `onRecord` also gets the whole record.
- `durableSettings.test.js`: removed the check against a renderer file that OMFV doesn't have.
- `f1tvCatalog.js`, `f1tvPlayback.js`: follow each feed's play link, so the base stream is requested with no `channelId`. Upstream sends
  `channelId=1025`, which F1 TV answers with a 404 through 2024. `f1tvCatalog.test.js` is new.

`src/data/vendor/` holds the same project's pure domain logic, unchanged. The app only uses `syncPlan.ts`. The rest stays to match upstream, including the timing reducer and replay controller
that `electron/timingdb` replaced.
