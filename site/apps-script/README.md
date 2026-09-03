# Waitlist backend

Emails go to a Google Sheet you own through a small Apps Script web app. One-time setup:

1. Create a Google Sheet. Rename the first tab to `waitlist`. Put these headers in row 1: `email`, `timestamp`, `referrer`, `user_agent`.
2. Open Extensions → Apps Script. Replace the default code with `Code.gs`. Set `SHEET_ID` to the long ID in the sheet's URL.
3. Deploy → New deployment → Web app. Execute as **Me**. Who has access: **Anyone**. Authorise when asked. Copy the URL ending in `/exec`.
4. Paste that URL into `WAITLIST_ENDPOINT` at the top of `site/app.js`. Commit.

Until the URL is set the page runs in demo mode: the conversation plays, nothing is stored, and a warning is printed in the browser console.

Redeploying the script creates a new version. Choose "Manage deployments" and edit the existing deployment to keep the same URL.

## What is stored

One row per unique email: the address, an ISO timestamp, the referrer and the user agent. Drop the last two columns from `appendRow` in `Code.gs` if you want email only.

## Abuse control

A hidden honeypot field, server-side dedupe by email, a script lock around the append, and Apps Script's own daily quota. No captcha.
