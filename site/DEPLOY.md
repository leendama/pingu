# Putting the page on your own domain

Squarespace is optional. This folder is a complete site — one HTML file, one
stylesheet, one script, no build step and no server — so a domain can point
straight at it. The Squarespace embed in `squarespace/` exists only if you want
the page to live inside an existing Squarespace site.

## 1. Turn on Pages

GitHub → **leendama/pingu → Settings → Pages → Build and deployment → Source:
GitHub Actions**. The repo is public, so this is free.

Merge this branch to `main`. `.github/workflows/pages.yml` publishes `site/` on
every push that touches it. The page is then live at
`https://leendama.github.io/pingu/`. Check it there before touching DNS.

## 2. Claim the domain in the repo

Add a file called `CNAME` in this folder containing nothing but the domain:

```
pingu.example.com
```

Commit it. GitHub reads that file on deploy and serves the site at that name.
Use exactly the host you want — `www.example.com` and `example.com` are
different entries.

## 3. Point DNS at GitHub

In whatever manages your domain's DNS (if the domain came from Squarespace,
that is **Settings → Domains → your domain → DNS Settings** — the DNS screen,
not the site editor):

**A subdomain** such as `pingu.example.com` or `www.example.com` — one record:

| Type  | Host    | Value                  |
| ----- | ------- | ---------------------- |
| CNAME | `pingu` | `leendama.github.io.`  |

**The bare domain** such as `example.com` — four A records, all on host `@`:

```
185.199.108.153
185.199.109.153
185.199.110.153
185.199.111.153
```

and, so it works over IPv6, four AAAA records on `@`:

```
2606:50c0:8000::153
2606:50c0:8001::153
2606:50c0:8002::153
2606:50c0:8003::153
```

Delete any existing A, AAAA or CNAME record on that same host first, or the two
destinations fight and the result is random. Values are from GitHub's own
[custom domain docs](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site).

A subdomain is less work and less risky: pointing the bare domain moves your
whole site off Squarespace, so anything else living there goes dark.

## 4. Wait, then turn on HTTPS

DNS takes anywhere from a few minutes to a day. Once **Settings → Pages** stops
showing a DNS warning, tick **Enforce HTTPS**. GitHub issues the certificate
itself; there is nothing to buy or renew.

## 5. Set the waitlist endpoint

The page animates but stores nothing until `WAITLIST_ENDPOINT` at the top of
`app.js` holds the Apps Script URL. See `apps-script/README.md`.

## If DNS is not where you expect

Registrar and DNS host can differ. Whoever answers `whois` for the domain is the
registrar; the nameservers it lists are who actually serves DNS, and that is
where these records go.
