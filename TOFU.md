# Tofu gallery copy

This repository is Tofu's copy of **thedevs-network/kutt** (licence: MIT), listed in Tofu's app gallery as **Kutt**: short links with click counts, on your own address.

- `main` mirrors the upstream repository and is never committed to by Tofu.
- `tofu` carries Tofu's own changes; tags named `pin/<date>` mark the versions the gallery points to. The current pin is `pin/2026-10-25`.
- A visitor who chooses this app gets a private snapshot of the pinned version in their own Tofu account. Their copy does not follow upstream updates.
- Upstream: https://github.com/thedevs-network/kutt at `029da42b2459693681886665589fd9512d6b473c` (2026-10-19, package version 3.2.6).

## How Tofu runs it

- Framework preset `container`, root folder: the repository root. Tofu builds the root `Dockerfile` and runs the image as a service, so there is no separate install command, build command or output directory.
- The `Dockerfile` (Node 22 on Alpine) runs `npm ci --omit=dev`, then starts with `npm run migrate && npm start`: knex runs Kutt's migrations (`server/migrations`), then `node server/server.js --production` starts the server. It listens on `PORT`, which Tofu sets (80 unless the app has a `PORT` setting). The image has no `USER` line, so the server runs as root, which port 80 needs.
- Database: PostgreSQL, the app's own Tofu database, read from `DATABASE_URL`. Kutt makes and updates its own tables at every start (knex keeps its record in `knex_migrations`). There is no `supabase/migrations` folder, so Tofu applies no migration files for this app.
- Settings Tofu saves for a copy: `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_CA_CERT` (the database), and `DEFAULT_DOMAIN`, which the gallery sets to the copy's own address. Nothing has to be typed before the first deploy. The image sets `NODE_ENV=production` and `CUSTOM_DOMAIN_USE_HTTPS=true`.
- One hidden value the owner saves after the first deploy: `ADMIN_SETUP_PASSWORD` (see "The first account").
- Settings an owner may add later: `SITE_NAME`; mail (`MAIL_ENABLED=true`, `MAIL_HOST`, `MAIL_PORT`, `MAIL_SECURE`, `MAIL_USER`, `MAIL_FROM`, and `MAIL_PASSWORD` as a hidden value); `REPORT_EMAIL` and `CONTACT_EMAIL`; `ENABLE_RATE_LIMIT=true`; their own `JWT_SECRET` (hidden, see "The sign-in secret"); sign-in with an identity provider (`OIDC_*`, with `OIDC_CLIENT_SECRET` hidden).
- Redis stays off (`REDIS_ENABLED=false`, upstream's default): visits are counted inside the server process, and rate limits, when turned on, are kept in its memory.

## What Tofu changes

Each change is a `Tofu: ...` commit on `tofu` whose message gives its reason.

- `server/tofu.js` (new, Tofu's own file). Everything below that is more than a line lives here, and it is called from:
  - `server/env.js`, before Kutt reads its settings:
    - **`DATABASE_URL`** (`postgres://` or `postgresql://`) fills `DB_CLIENT=pg` and each of `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` (decoded), `DB_SSL` that is not set. Kutt has no setting that takes a URL, and without one it falls back to SQLite in `db/data`, which loses every link at each restart on hosting without a disk. A `DB_*` setting the owner sets is kept.
    - **TLS.** `DATABASE_URL`'s `sslmode` decides `DB_SSL` and the new `DB_SSL_REJECT_UNAUTHORIZED`: `disable` and `allow` connect without TLS; `prefer`, `require` and `no-verify` encrypt; `verify-ca` and `verify-full` also check the certificate. The new `DB_SSL_CA` is filled from `SUPABASE_CA_CERT`, the database's certificate, which Tofu saves beside `DATABASE_URL`.
    - **`JWT_SECRET`** is derived from `DATABASE_URL` when it is not set (see "The sign-in secret").
    - **`DEFAULT_DOMAIN`** given as an address (`https://<name>.trytofu.app`, as the gallery saves it) is read as its host. Kutt builds every short link as `https://<DEFAULT_DOMAIN>/<address>`.
  - `knexfile.js` (the migrations) and `server/knex.js` (the server) take their TLS option from it. Upstream passes `DB_SSL=true` to node-postgres as it is, which checks the server's certificate against Node's own list of authorities, and a managed database's pooler does not pass that. Now: checked against `DB_SSL_CA` when there is one; encrypted without checking when there is none and `DB_SSL_REJECT_UNAUTHORIZED=false`; as upstream otherwise.
  - `server/server.js`: turns row-level security on for Kutt's tables before the server takes requests (see "Kutt's tables and Supabase's Data API").
  - `server/handlers/auth.handler.js`, `server/handlers/locals.handler.js` and `server/views/partials/auth/form_admin.hbs`: the setup password for the first account (see "The first account").
  - `server/env.js` also declares the three new settings, `DB_SSL_REJECT_UNAUTHORIZED` (default `true`), `DB_SSL_CA` and `ADMIN_SETUP_PASSWORD`.
- `Dockerfile`:
  - `package.json` and `package-lock.json` are copied in with `COPY` instead of bind-mounted for `npm ci`. Tofu's container hosting builds with buildah, not Docker's BuildKit, and a cache mount is the one `RUN --mount` form a gallery image has been built with there so far (HomeBox's). The cache mount stays.
  - `ENV CUSTOM_DOMAIN_USE_HTTPS=true`: a domain connected to the app on Tofu is served over HTTPS, so short links on a custom domain start with `https://`. The owner can set it back to `false`.
- `server/views/partials/settings/domain/index.hbs`: Settings > Custom domain told people to point their domain's A record at "our IP address", which a copy on Tofu does not have. With neither `SERVER_IP_ADDRESS` nor `SERVER_CNAME_ADDRESS` set, it now says to connect the domain on the app's Domains page in Tofu first. With either set, the text is upstream's.
- `.example.env` names the new settings.
- No file was removed. Upstream's three GitHub Actions workflows (Docker image builds) stay; a copy never runs them.

## The first account

A new Kutt has no account. Its first visitor is sent to `/create-admin`, and the account made there is the administrator. A copy is online at a public address before its owner first opens it, so on Tofu that page only completes with the setup password:

1. After the first deploy, the owner opens the app's **Keys & settings** page in Tofu, saves `ADMIN_SETUP_PASSWORD` with **Hide this value after saving** turned on (at least 12 characters; a long random one is best, for example the output of `openssl rand -base64 24`), and deploys again.
2. The owner opens the copy, which shows "Create an Admin account first", and enters their email address, a password for the account, and the setup password.

- Until `ADMIN_SETUP_PASSWORD` is saved, the page explains this and shows no form, and a request to create the account (`POST /api/auth/create-admin`, also as `/api/v2/...`) is refused. A saved value shorter than 12 characters is refused the same way.
- Wrong setup passwords are counted for the whole server, not per visitor: after ten wrong ones in ten minutes, every attempt, the right one included, waits until ten minutes have passed. A stranger who keeps guessing can therefore make the owner wait. Making the app private on Tofu until the account exists stops that.
- Once any account exists, the page sends people to the sign-in page, and the setup password is never read again. Changing or removing it later changes nothing.
- Sign-up is closed: `DISALLOW_REGISTRATION` is `true` by default, and sign-up also needs mail, which is off. The administrator adds the other people under **Admin > Users > Create user** (keep **Verified** ticked, as it is by default). Making links needs an account: `DISALLOW_ANONYMOUS_LINKS` is `true` by default, and an owner should keep it so on a public address.

## The sign-in secret

Kutt signs every sign-in cookie with `JWT_SECRET` and does not start in production without one.

- When `JWT_SECRET` is not set and `DATABASE_URL` is, it is the SHA-256 of `kutt-jwt-secret:` followed by the whole `DATABASE_URL`, as 64 hex characters, worked out at every start. It is only as secret as `DATABASE_URL`, which Tofu keeps as a hidden value.
- Anything that changes `DATABASE_URL` (a new database password, another host or pooler address, other options, a database brought back under another address) changes it at the next start, and everyone has to sign in again. Links, visits, accounts and API keys are not affected: API keys are kept in the database.
- To keep sign-ins across such a change, save your own `JWT_SECRET` as a hidden value (a long random string) and keep it unchanged. Saving it signs everyone out once.

## Kutt's tables and Supabase's Data API

Tofu's databases are Supabase PostgreSQL. On a database whose default privileges still give every new table in `public` to the Data API's roles (`anon` and `authenticated`), which is every Tofu database created before 2026-10-30, anyone with the project's public key could read and change Kutt's tables through the Data API: `users`, with password hashes and API keys, included.

- At every start, before taking requests, Kutt turns row-level security on, with no policy, for its own tables that do not have it yet: `users`, `ips`, `domains`, `hosts`, `links`, `visits`, `knex_migrations` and `knex_migrations_lock`, where its own role owns them. The log says `Turned on row-level security on 8 of Kutt's tables for Supabase's Data API` at the first start and nothing at later ones.
- With row-level security on and no policy, those roles see no row and can change nothing. Kutt's own connection owns the tables, so it is not limited.
- It never turns row-level security off, touches no other table, and does nothing on a database without those roles. Each change waits at most 5 seconds for a lock. If it fails, Kutt logs `Could not turn on row-level security on Kutt's tables` and starts anyway.

## What works differently on Tofu

- **No email by default.** Email verification, password reset, changing an account's email address and the abuse-report form need mail settings (`MAIL_*`), which a copy does not have. Without them, a forgotten password cannot be reset from the app: to reset one, add mail settings and deploy again, then use "Forgot password?".
- **Custom domains.** Connect the domain on the app's Domains page in Tofu first. Then either set `DEFAULT_DOMAIN` to it and deploy again, so all short links use it, or add it under Kutt's **Settings > Custom domain**, so links can choose it. A custom domain added there can also name a homepage, where Kutt sends visitors who open the domain's bare address.
- **Visitor countries** come from the GeoLite data geoip-lite ships with, looked up for the first address in `X-Forwarded-For` (`TRUST_PROXY=true`, upstream's default). geoip-lite's README asks for that data to be updated with a MaxMind licence key; a copy never updates it, so addresses in ranges assigned since may show as "Unknown" or a wrong country. geoip-lite 2.0.2 declares Node 24 or newer; the image uses Node 22, as upstream's does, and lookups worked on Node 22 here.
- **Expired links** are deleted by a timer inside the running server every 30 seconds.
- **Safari** visits are counted as browser "Other" (upstream).
- **The homepage logs one script error** on every load, `Cannot read properties of null (reading 'style')` at `onSearchInputLoad` in `static/scripts/main.js`: upstream's code, unchanged here. Nothing visible breaks.
- The header's GitHub link, the footer's "Powered by Kutt" and the API key panel's link to `docs.kutt.to` lead to upstream, as upstream has them.

## Needs a real deploy to verify

- The image builds on Tofu's container hosting with buildah, including the npm cache mount and better-sqlite3's install step, which downloads a prebuilt binary for Alpine (linux-musl) during `npm ci`. better-sqlite3 is not used with PostgreSQL, but it is one of Kutt's dependencies.
- The first start through Tofu's `DATABASE_URL` (the transaction pooler, port 6543), with TLS checked against `SUPABASE_CA_CERT`: the log shows the migrations, the row-level security line, then `> Ready on http://localhost:80`. Kutt's queries go through knex and node-postgres, which use only unnamed statements, so the runtime logs should show no `prepared statement` errors (SQLSTATE 26000 or 42P05).
- The `/create-admin` page before and after the owner saves `ADMIN_SETUP_PASSWORD` and deploys again.
- Short links on the copy's address redirect, and their visits are counted with the visitor's country, which depends on whether Tofu's proxy puts the visitor's own address first in `X-Forwarded-For`. If a visitor could set that header themselves, they could also choose the address that rate limits (when turned on) count them under.
- A custom domain connected on Tofu reaches the container with its own `Host`, so Kutt's custom domains work.

## Licence

- MIT. `LICENSE` and every copyright notice stay exactly as upstream has them. `server/tofu.js` is Tofu's own file, and every other file Tofu changed carries a `Tofu (2026-10-25)` note at the change. MIT asks for no source offer.
- The Kutt name and logo belong to the upstream project; the gallery uses them only to say which app this is.
- Bundled by upstream: the Nunito font (`static/fonts/nunito-variable.woff2`, SIL Open Font License 1.1, with no copy of that licence in the repository); Chart.js, htmx and qrcode.js (`static/libs/`, each under its own licence); and the world map the stats page draws (`server/utils/map.json`, whose source the repository does not name).
- The image installs Kutt's npm packages (`package-lock.json`), each under its own licence. geoip-lite among them carries country data by MaxMind ("This product includes GeoLite data created by MaxMind, available from http://maxmind.com/"), under MaxMind's terms.
- Upstream's lockfile is used as it is. `npm audit --omit=dev` lists 12 advisories in the production packages (3 critical: handlebars and hbs, the server's own page templates, and proxy-addr), which this copy does not change.

## Verification

2026-10-25, on macOS arm64, against 127.0.0.1 only. No Docker (its daemon is not running here), nothing deployed. Node 22.22.3 and npm 10.9.8, the image's Node major version.

- The tree: `git archive` of the tested commit, whose tree is identical to `tofu` at `a2682282f155e024148995f821005b60156edd13`, unpacked with every file's execute bit removed (`find <dir> -type f -exec chmod a-x {} +`). Everything below ran from that tree, as the image would run it.
- Install: `NODE_ENV=production npm ci --omit=dev` added 245 packages in 3 s, including better-sqlite3's prebuilt binary for this Mac. The one warning: geoip-lite 2.0.2 declares Node 24 or newer.
- `server/tofu.js`, 8 unit checks, all passed: a pooler URL with a percent-encoded user and password and a host on a `.pooler.` domain that is not Supabase's; settings the owner set are kept; IPv6, `verify-full`, no port and no `sslmode`; a URL that is not `postgres://` changes nothing; `JWT_SECRET` is derived only when unset, the same for the same URL and different for another; `DEFAULT_DOMAIN` as an address; the TLS option; the setup password, including the wait after ten wrong ones.
- Database: a scratch PostgreSQL 14 cluster on 127.0.0.1 that accepted TLS connections only, with a throwaway certificate authority, Supabase-like `anon` and `authenticated` roles holding the old default privileges on new tables in `public`, and a login role named like a pooler user (`kutt.r9b`). It used trust authentication, so the URL's password reached no password check; its decoding is in the unit checks.
- TLS, through Kutt's own `server/knex.js`, with `DATABASE_URL` and nothing else for the database: `sslmode=require` connected over TLSv1.3 without `SUPABASE_CA_CERT`, and with it as PEM text and as base64; with the certificate of another authority it was refused (`unable to verify the first certificate`); `verify-full` with the right certificate connected; `sslmode=disable` was refused by the server (`no encryption`); upstream's own `DB_SSL=true` without `DATABASE_URL` was refused (`unable to verify the first certificate`), which is the failure this copy avoids.
- Run as the image's `CMD` (`npm run migrate && npm start`) with only `NODE_ENV=production`, `CUSTOM_DOMAIN_USE_HTTPS=true`, `PORT`, `DATABASE_URL` (`...?sslmode=require`), `SUPABASE_CA_CERT` and `DEFAULT_DOMAIN=https://trytofu.ai`: the log read `Batch 1 run: 10 migrations`, `> Turned on row-level security on 8 of Kutt's tables for Supabase's Data API`, `> Ready on http://localhost:43117`. After a restart there was no row-level security line. The server's log showed no error in any run.
- Row-level security: all 8 tables had it on while `anon` still held SELECT and INSERT on each. As `anon`, `knex_migrations` and `users` showed 0 rows, and an insert into `knex_migrations_lock` was refused (`new row violates row-level security policy`). Kutt's own role read its 10 migration rows.
- The first account:
  - Without `ADMIN_SETUP_PASSWORD`: `GET /` and `GET /login` answered 302 to `/create-admin`, which answered 200 with the explanation and no form; `POST /api/v2/auth/create-admin` answered 403 with the sentence.
  - With a 9-character value: 403, "shorter than 12 characters".
  - With a long value: without the setup password, 401; nine more wrong ones, 401 each; then the right one, 429 ("Too many wrong setup passwords"). After a restart, the right one answered 201 with a token; a second request, 400 ("a user already exists"); and `/create-admin` now answered 302 to `/login`. Through the HTML form, a wrong setup password showed "The setup password is not correct." under the field.
- Links: signed in through the API; `POST /api/v2/links` made `bread`, shown as `https://trytofu.ai/bread`, so the address given in `DEFAULT_DOMAIN` became its host. `GET /bread` answered 302 to its target; the list then showed 1 visit, and its stats counted the country `gb` (from `X-Forwarded-For`, through geoip-lite on Node 22) and the referrer.
- Browser: Playwright's headless Chromium 156, 127.0.0.1 only. Signed in on `/login`; made `picnic` through the homepage form with its own address and a description, and the page showed `trytofu.ai/picnic` and listed it in the table; a link's stats page drew its chart. The only page error was upstream's `onSearchInputLoad` one on each homepage load (see above); no request failed.
- Not run: a stand-in for a transaction-mode pooler. The reasoning above (knex and node-postgres use unnamed statements only; each migration and each row-level security change runs in one transaction) is unchecked against a real pooler.
- Tofu's own check on the pushed `tofu` branch at `a2682282f155e024148995f821005b60156edd13` (the code, before this file was added), which runs Tofu's GitHub import, the static lane's predicates and the safety check, printed `kutt tofu root=(repo) detect=container files= 221 published= 211 -> not on the static lane | refused: typex5, server_codex187, configurationx2 | build: not_vite | safety ok (1 findings)` and `free static limit: 211/500 published files | archive 200 424306`. The import keeps every tracked file except upstream's stray `static/.DS_Store`, and no finding is critical or high. The copy runs on Tofu's server hosting, so the static lane's file limit does not apply to it.
- All local servers were stopped and the scratch database cluster deleted afterwards.
