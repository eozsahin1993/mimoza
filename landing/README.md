# mimoza-landing

The website, `joinmimoza.com`: a Vite + React site with four pages and
two Cloudflare Pages Functions. How it fits into the rest of the
infrastructure is in
[docs/INFRASTRUCTURE.md](../docs/INFRASTRUCTURE.md#the-website); this
file is just how to run and change it.

## Layout

```
index.html            /              the marketing page
privacy/index.html    /privacy/      privacy policy
support/index.html    /support/      support page with a contact form
delete-account/       /delete-account/  account deletion steps and request form
src/
  main.tsx, privacy.tsx, support.tsx, delete-account.tsx   one entry per page
  pages/              the three static pages
  sections/           the marketing page, one folder per section
  components/         shared pieces: forms, wordmark, phone mockup, icons
  styles/             base.css (tokens, reset), staticPage.css (policy pages)
  config.ts           APP_IS_LIVE: flips every Download CTA from waitlist to store badges
functions/api/
  subscribe.ts        /api/subscribe  waitlist, writes a contact to Resend
  contact.ts          /api/contact    support and deletion forms, sends mail through SES
shared/send-email.ts  the SES client contact.ts signs requests with
public/               favicon, og-image, robots.txt, sitemap.xml, copied as-is
```

Each page is a separate Vite input in `vite.config.ts`, not a client
route. Pages serves `index.html` for any path it has no file for, so a
route that only existed in JavaScript would 200 with the homepage when
a store reviewer fetches it. Adding a page means a new `<dir>/index.html`,
a new `src/<name>.tsx` entry, a line in `rollupOptions.input`, and a
line in `public/sitemap.xml`.

## Run it locally

Node is pinned in `../app/.node-version`; the deploy uses the same file.

```sh
npm ci
npm run dev        # http://localhost:5173, hot reload, static pages only
npm run typecheck
npm run build      # writes dist/
npm run preview    # serves dist/ as the host would
```

`vite dev` doesn't run `functions/`, so the waitlist and contact forms
answer "something went wrong" there. To exercise them, build and serve
the output through wrangler, which picks up `functions/` as a sibling of
the directory it serves:

```sh
npm run build
npx wrangler pages dev dist
```

Secrets for a local run go in `landing/.dev.vars`, which is gitignored:

```
AWS_ACCESS_KEY_ID=...        # the website-mailer IAM user, see modules/email
AWS_SECRET_ACCESS_KEY=...
RESEND_API_KEY=...           # waitlist only; needs a Full access key
```

Without them `/api/contact` answers 500 "isn't configured yet" rather
than failing silently, so a blank form in dev is expected, not a bug.

## Deploy

Pushing to `main` with anything under `landing/` changed runs
`.github/workflows/landing-deploy.yml`: `npm ci`, typecheck, build, then
`wrangler pages deploy dist` to the `mimoza-landing` Pages project.
There is no staging site. The same secrets as above are set once on the
Pages project in the Cloudflare dashboard, not in the workflow.
