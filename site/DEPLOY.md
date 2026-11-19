# Deploying the site

The site runs on Cloudflare Workers as static assets, with no adapter and no Worker script. Two Workers come from one `wrangler.jsonc`:

| Worker | Built from | Serves | Who can open it |
| --- | --- | --- | --- |
| `omfv-site-staging` (`--env staging`) | `main` | https://omfv-staging.yueyao.run | Only the owner, through Cloudflare Access |
| `omfv-site` | `site-production` | https://oh-my-f1-viewer.yueyao.run | Everyone |

https://omfv.yueyao.run redirects to production. Neither Worker has a `workers.dev` address or preview URLs, so each custom domain is the only way in.

```
merge to main (site/ changed) ─► Workers Builds builds omfv-site-staging ─► omfv-staging.yueyao.run

publish a release tagged site-v* ─► "Release site" action moves site-production to the tag
                                  ─► Workers Builds builds omfv-site ─► oh-my-f1-viewer.yueyao.run
```

## Ship to production

Look at staging first: it always shows the latest `main`. Then publish a release for a commit on `main` with a tag that starts with `site-v`:

```bash
gh release create site-v1.2.0 --target main --title "Site v1.2.0" --generate-notes --notes-start-tag site-v1.1.0
```

Or use **Releases → Draft a new release** on GitHub. The [Release site](../.github/workflows/site-release.yml) action then fast-forwards `site-production` to the tag, and Workers Builds deploys it. The action skips:

- tags without the `site-v` prefix, so the app's releases never touch the site
- pre-releases
- a tag whose commit isn't on `main`, so production only gets what staging has shown

## Roll back

Go to **Actions → Release site → Run workflow** and enter an older tag, such as `site-v1.1.0`. Run by hand, the action may move `site-production` backwards, and only then does it force-push. Publishing a release never force-pushes.

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
