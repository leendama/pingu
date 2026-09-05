# Squarespace embed

`embed.html` is the whole waitlist page as one paste-able block: markup, styles,
script and the penguin (as a data URI) inlined, with every selector scoped to
`#pingu-waitlist` and every id namespaced, so it cannot collide with a template's
CSS in either direction.

It is generated, not hand-written. After changing anything in `site/`, run:

```sh
node site/squarespace/build.mjs
```

then re-paste. Editing `embed.html` directly means the next build overwrites you.

## Putting it on the site

A Code Block needs a Squarespace **Business plan or higher**. On Personal, use
the iframe fallback below instead.

1. Set `WAITLIST_ENDPOINT` in `site/app.js` first (see `../apps-script/README.md`),
   then re-run the build. Without it the page animates but stores nothing.
2. In Squarespace: **Pages -> +** and add a blank page. Name it, then set it as the
   home page if the waitlist is the whole site.
3. Open the page, **Edit -> Add Block -> Code**. Delete the sample markup, paste
   all of `embed.html`, and turn **Display Source** off. Save.
4. Still on that page: **gear icon -> Advanced -> Page Header Code Injection**.
   Paste `page-injection.html`. Save.
5. **Save** the page, then check it in an incognito window on a phone and a laptop.

Step 4 hides the header and footer on this page only. Skip it if you want the
site's navigation to stay above the conversation; the block works either way.

The selectors it hides cover both Squarespace 7.0 and 7.1. If a header survives
on your template, right-click it, Inspect, and add that element's id or class to
the list.

## Editing afterwards

The block is full-bleed and a viewport tall, so in the Squarespace editor it
fills the canvas. To get back to the page list, use the browser back button or
the left sidebar rather than scrolling.

## iframe fallback

If Code Blocks are unavailable, host `site/` on GitHub Pages (the workflow in
`.github/workflows/pages.yml` already does this on pushes to `main`) and embed it:

```html
<iframe src="https://leendama.github.io/pingu/" title="Pingu waitlist"
        style="width:100vw;margin-left:calc(50% - 50vw);height:100dvh;border:0;display:block"></iframe>
```

Same page, one HTTP request away. The trade-off is that the address bar shows the
Squarespace URL while the content comes from GitHub, so link previews and
analytics see the frame, not the conversation.
