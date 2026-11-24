# Live deployment checks

**Date:** 24 November 2026
**URL:** https://data-quality-agent.data-quality-agent.workers.dev
**Plan:** Cloudflare Workers Free

## Deploy

```
npx wrangler deploy
Your Worker has access to the following bindings:
env.ANALYZE_LIMITER (5 requests/60s)          Rate Limit
env.CLAUDE_MODEL ("claude-haiku-5-5")         Environment Variable
env.MAX_ROWS ("2000")                         Environment Variable
env.DEMO_MODE ("false")                       Environment Variable
Worker Startup Time: 9 ms
Deployed data-quality-agent triggers
  https://data-quality-agent.data-quality-agent.workers.dev
```

First attempt failed with `You need to verify your email address to use Workers [code: 10034]`. It worked after verifying the account email.

## Secret

```
npx wrangler secret put ANTHROPIC_API_KEY
✨ Success! Uploaded secret ANTHROPIC_API_KEY

npx wrangler secret list
[ { "name": "ANTHROPIC_API_KEY", "type": "secret_text" } ]
```

Before deploying I checked that the key was not in any uploaded file (`grep "sk-ant-"` on the build output returned 0 matches).

## Smoke tests

```
GET /api/health   -> {"ok":true,"model":"claude-haiku-5-5","mock":false}
GET /             -> HTTP 200, 749 bytes, 0.28 s
GET /.dev.vars    -> app page only, no secrets
GET /wrangler.json -> app page only, no config
GET /index.js.map -> app page only, no source
```

For about 90 seconds after the first deploy the site returned SSL errors (curl exit code 35) while the certificate for the new workers.dev address was issued.

## Security check: rate limiting

Empty requests (rejected as "no data rows", so no Claude API cost), about 1 second apart, from one IP:

```
1:400 2:400 3:400 4:400 5:429 6:400 7:429 8:429 9:429 10:429
11:429 12:429 13:429 14:429 15:429 16:429 17:429 18:429 19:429 20:429
```

`400` = request allowed (then rejected as empty). `429` = blocked by the rate limiter.

An earlier burst of 7 requests straight after the first deploy was not blocked at all. Cloudflare's rate limiter counts per data centre and syncs with a delay, so it is approximate.

## Functional test: evals against the live URL

```
npm run eval -- https://data-quality-agent.data-quality-agent.workers.dev 3 live 13000
```

| file | run | found | exact_counts | unexpected | score | turns | tokens | cost_usd | seconds |
|---|---|---|---|---|---|---|---|---|---|
| clean_customers | 1 | 0/0 | 0/0 | 0 | 100 | 3 | 12961 | 0.0016 | 4.3 |
| clean_customers | 2 | 0/0 | 0/0 | 0 | 100 | 3 | 12917 | 0.0016 | 4.4 |
| clean_customers | 3 | 0/0 | 0/0 | 0 | 100 | 3 | 12949 | 0.0016 | 4.3 |
| messy_customers | 1 | 10/10 | 10/10 | 1 | 55 | 2 | 10565 | 0.0019 | 9.2 |
| messy_customers | 2 | 10/10 | 10/10 | 0 | 62 | 2 | 10499 | 0.0019 | 9.0 |
| messy_customers | 3 | 10/10 | 10/10 | 0 | 62 | 2 | 10678 | 0.0020 | 9.8 |

Total cost: US$0.0106. The one unexpected issue was a low-severity, 0-row note that phone values are masked.
