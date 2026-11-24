# Security: what the app does, and what the server/DNS must do

## In the app (nothing to configure)

- **Panels**: `/admin` and `/team` (and `/api/admin`) require the right role. Access is decided on the decoded, normalised path, so `/%61dmin`, `//ADMIN` or `/a/../admin` get exactly the same sign-in check.
- **Forms**: every state-changing request must come from this site (Origin check) **and** carry the visitor's CSRF token (`__Host-isec_csrf` cookie + `_csrf` field or `X-CSRF-Token` header). Game-server ingest URLs use their secret key instead.
- **Sign-in throttling** (by the visitor's real address, see below):
  - 5 failures per address and username, then a growing wait (30 s doubling to 15 min).
  - 10 failures per username from anywhere, then the same wait. Addresses that signed in to that account before are exempt, so the real admin can't be locked out.
  - 60 failures per address in 15 minutes, against password spraying.
  - A school or office behind one shared address isn't locked out by one person on it.
  - Refusals are `429` with `Retry-After`.
- **Rate limits**:
  - 240 page requests and 60 writes per minute per visitor;
  - more than 150 "not found" answers in 10 minutes (URL guessing) blocks the visitor for 10 minutes;
  - static assets and the live stream don't count.
- **Headers**: CSP, HSTS, nosniff, frame denial, referrer and permissions policy on **every** response, including errors and redirects. Methods other than GET/HEAD/POST/PUT/PATCH/DELETE/OPTIONS get `405` (`server.mjs`).
- **Uploaded images** (`/media/u/`): only PNG/JPEG/WebP are accepted. They are served only through signed, expiring URLs, only as resized WebP copies (never the original), and only to this site's own pages.
- **`/flags/`**: public country-flag icons (open-source flag-icons set), sandboxed SVG. There is nothing private there.

## Behind the reverse proxy

The app uses the right-most `X-Forwarded-For` entry when the connection comes from loopback or a private (Docker) address. Caddy sets that header to the real client address. So:

1. **Never publish the app port to the internet**, only Caddy's 80/443. In `docker-compose.yml` use `expose: ["4321"]` (or `ports: ["127.0.0.1:4321:4321"]`), not `ports: ["4321:4321"]`. Otherwise someone could reach the app directly and fake their address.
2. If Caddy runs elsewhere (not loopback/private), list its address in `TRUSTED_PROXIES`.
3. Never set `ISEC_RATE_LIMIT=off` in production (it exists for load tests).
4. Start the app with `node server.mjs` (the Dockerfile does), not `dist/server/entry.mjs`.

Recommended Caddyfile for the site:

```caddy
isec.net.cn {
	encode zstd gzip
	reverse_proxy isec:4321 {
		# Don't announce the proxy.
		header_down -Via
	}
	header {
		-Server
		-Via
	}
}
```

Check on the server that Caddy's admin API is only on localhost:

```bash
sudo ss -lntp | grep 2019
```

(It should show `127.0.0.1:2019`, or nothing if it runs inside Docker without a published port.)

## DNS (DNSPod): add these records

The domain sends no mail. Without these records anyone can send mail that claims to be `@isec.net.cn`:

| Host | Type | Value |
| --- | --- | --- |
| `@` | TXT | `v=spf1 -all` |
| `_dmarc` | TXT | `v=DMARC1; p=reject; sp=reject; adkim=s; aspf=s` |
| `@` | CAA | `0 issue "letsencrypt.org"` |
| `@` | CAA | `0 issuewild ";"` |

Also turn on **DNSSEC** in DNSPod (one switch).

Some other details to keep in mind:

- If you later send mail from the domain, change SPF to include that provider and add its DKIM record.
- To receive DMARC reports, add `rua=mailto:<a mailbox you read>` to the DMARC record.

## Later

- **HSTS preload**: once everything (including any future subdomain) is HTTPS-only, add `; preload` to the HSTS header and submit at hstspreload.org. It is hard to undo, so don't rush it.
