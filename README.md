# tcg-proxy

A Cloudflare Worker that sits between the Pokémon Finder frontends and the
[Pokémon TCG API](https://pokemontcg.io/). It exists so the API key never
reaches a browser.

Live at `https://tcg-proxy.tcg-proxy.workers.dev`.

## Who calls it

- [pokemon-finder-react](https://github.com/elpsykongroo14/pokemon-finder-react):
  the Library page and the Pokémon page's cards teaser
- Local development of that app (`localhost:5173`, and `localhost:4173` for
  its Playwright tests)

The original vanilla app
([pokemon-finder](https://github.com/elpsykongroo14/pokemon-finder), archived)
used it too until November 2026; its origin has been removed from the allowlist.

## What it does, in request order

1. **CORS:** answers the browser's `OPTIONS` preflight, and adds
   `Access-Control-Allow-Origin` only for allowed origins (an exact list plus
   one anchored pattern for the React app's Pages previews).
2. **Rate limit:** 100 requests per 60 seconds per client IP (`429` above that).
3. **Method check:** `GET` only (`405` otherwise).
4. **Cache:** answers from KV when it can (`X-Cache: HIT`); successful upstream
   answers are cached for 24 hours. Errors are never cached.
5. **Upstream call:** forwards the query string to `api.pokemontcg.io/v2/cards`
   with the secret key, retrying once after a server-side failure.
6. **Errors:** every response, including failures, carries the CORS headers,
   so the browser shows the app's own error message, not a CORS error.

## Configuration

| Name               | Kind                  | Where it lives                    |
| ------------------ | --------------------- | --------------------------------- |
| `TCG_API_KEY`      | secret                | `wrangler secret put TCG_API_KEY` |
| `TCG_CACHE`        | KV namespace binding  | `wrangler.jsonc`                  |
| `TCG_RATE_LIMITER` | rate limiting binding | `wrangler.jsonc`                  |

## Run it locally

```bash
npm ci
cp .dev.vars.example .dev.vars   # then put your real key in .dev.vars
npm run dev                      # http://localhost:8787
```

`wrangler dev` simulates KV and the rate limiter locally, so local testing never
touches the production cache.

## Deploy

`npm run deploy:dry-run` checks the build and lists the bindings without
uploading. Production deploys are done by CI (see `.github/workflows/`).

## History

This service lived in `tcg-proxy/` inside the vanilla repo until November 2026.
It was moved here with its history (`git subtree split`), so `git log` and
`git blame` still show why each part exists.
