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

## 2. The domain is already claimed

`site/CNAME` contains `www.trycolty.com`. GitHub reads it on every deploy and
serves the site under that name. Nothing to do here.

`www` is the canonical host; once the records below are in, GitHub redirects
`trycolty.com` to `www.trycolty.com` on its own.

## 3. Change two things in Squarespace DNS

trycolty.com uses Squarespace's nameservers (`nsd1-4.squarespacedns.com`), so the
records live in **Settings -> Domains -> trycolty.com -> DNS Settings**. That is a
records table, not the site editor.

Today the domain points at Squarespace:

| Host  | Type  | Current value                                                        |
| ----- | ----- | -------------------------------------------------------------------- |
| `@`   | A     | 198.185.159.144, 198.185.159.145, 198.49.23.144, 198.49.23.145        |
| `www` | CNAME | `ext-sq.squarespace.com`                                              |

**Leave the MX and TXT records alone.** trycolty.com receives mail through Google
Workspace (`smtp.google.com`, plus the SPF TXT record). Touching those breaks
email. Only the A and CNAME rows above change.

**Replace the `www` CNAME.** Point it at GitHub instead:

| Host  | Type  | New value             |
| ----- | ----- | --------------------- |
| `www` | CNAME | `leendama.github.io.` |

**Replace the four `@` A records** with GitHub's, so the bare domain redirects to
`www` rather than dying:

```
185.199.108.153
185.199.109.153
185.199.110.153
185.199.111.153
```

and add four AAAA records on `@` so it also answers over IPv6:

```
2606:50c0:8000::153
2606:50c0:8001::153
2606:50c0:8002::153
2606:50c0:8003::153
```

Values are from GitHub's own
[custom domain docs](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site).

Squarespace may warn that the domain is no longer connected to the site. That is
the intended outcome: the waitlist page becomes what trycolty.com serves.

## 4. Wait, then turn on HTTPS

DNS takes minutes to a day. When **Settings -> Pages** stops showing a DNS
warning, tick **Enforce HTTPS**. GitHub issues the certificate; nothing to buy
or renew.

## 5. Set the waitlist endpoint

The page animates but stores nothing until `WAITLIST_ENDPOINT` at the top of
`app.js` holds the Apps Script URL. See `apps-script/README.md`.

## Backing out

Put the four Squarespace A records and the `ext-sq.squarespace.com` www CNAME
back and the domain returns to the Squarespace site. Nothing here is one-way.
