# Vendored from F1 OpenViewer

These modules come from [F1 OpenViewer](https://github.com/npanu420/F1OpenViewer) (MIT, see `LICENSE`) at
commit `6607ead`. They hold hard-won behaviour for F1 TV sign-in, entitlement, DRM licensing and timing, so
they stay as close to upstream as possible and are wrapped rather than rewritten.

Local changes:

- `session.js`: profile file names use `f1a-` instead of `f1openviewer-`.
- `livetiming.js`: the User-Agent for the public sync API says `f1a`.
- `durableSettings.test.js`: removed the check against a renderer file that f1a doesn't have.

`src/data/vendor/` holds the same project's pure domain logic (sync decisions, timing reducer, replay
controller), unchanged.
