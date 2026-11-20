# Deploying the site

The site runs on Cloudflare Workers as static assets, with no adapter and no Worker script. Two Workers come from one `wrangler.jsonc`:

| Worker | Built from | Serves | Who can open it |
| --- | --- | --- | --- |
| `omfv-site-staging` (`--env staging`) | `main` | https://omfv-staging.yueyao.run | Only the owner, through Cloudflare Access |
| `omfv-site` | `site-production` | https://oh-my-f1-viewer.yueyao.run | Everyone |

https://omfv.yueyao.run redirects to production. Neither Worker has a `workers.dev` address or preview URLs, so each custom domain is the only way in.

```
merge to main (site/ changed) ─► Workers Builds builds omfv-site-staging ─► omfv-staging.yueyao.run

run "Release site" with a commit ─► the action moves site-production to it
                                 ─► Workers Builds builds omfv-site ─► oh-my-f1-viewer.yueyao.run
```

## Ship to production

Look at staging first: it always shows the latest `main`. Then run the [Release site](../.github/workflows/site-release.yml) action with
the commit to ship, from **Actions → Release site → Run workflow** or:

```bash
gh workflow run site-release.yml -f sha=main      # what staging shows now
gh workflow run site-release.yml -f sha=1a2b3c4   # a particular commit
```

The action moves `site-production` to that commit and Workers Builds deploys it. It refuses a commit that isn't on `main`, so
production only gets what staging has shown. Nothing is tagged and no GitHub release is made: `site-production` is the record of
what's live, and the action's runs are the history.

## Roll back

Run the same action with an older commit on `main`. Only then does it force-push, with a lease on where `site-production` was.

For an instant rollback that skips the build, go to **Workers & Pages → omfv-site → Deployments** in the dashboard and roll back to an earlier version. The next release replaces it.

## Where the settings live

The repo holds `wrangler.jsonc` (Workers, custom domains, assets) and the release action. Everything else is in the Cloudflare dashboard.

**Workers Builds**, in **Workers & Pages → (Worker) → Settings → Build**:

| Setting | `omfv-site` | `omfv-site-staging` |
| --- | --- | --- |
| Git repository | `natheihei/oh-my-f1-viewer` | same |
| Branch | `site-production` | `main` |
| Root directory | `site` | `site` |
| Build command | `npm run build` | `npm run build` |
| Deploy command | `npx wrangler deploy --env=""` | `npx wrangler deploy --env staging` |
| Preview command | left at its default, never runs | same |
| Build watch paths | include `site/*` | include `site/*` |
| Branch control: preview builds | off | off |

Both use the build image's default Node. Astro 7 needs 22.12 or newer, and Cloudflare's Astro guide says the default meets that.

**Zero Trust → Access controls → Applications**: the self-hosted app `OMFV staging site` on `omfv-staging.yueyao.run`, with an Allow policy for the owner's email and one-time PIN sign-in.

**yueyao.run zone**:

- A proxied `AAAA omfv → 100::` record, which only exists so traffic reaches Cloudflare.
- A Redirect Rule `omfv to oh-my-f1-viewer`: hostname equals `omfv.yueyao.run`, a dynamic 301 to `concat("https://oh-my-f1-viewer.yueyao.run", http.request.uri.path)` that keeps the query string.

The custom-domain records for `oh-my-f1-viewer` and `omfv-staging` belong to the Workers. Don't edit them by hand.

## Deploy by hand

Normally builds deploy themselves. To deploy from your machine, after `npx wrangler login`:

```bash
npm run build
npx wrangler deploy --env staging   # staging
npx wrangler deploy --env=""        # production: prefer a release
```
