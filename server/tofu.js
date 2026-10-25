// Tofu (2026-10-25): this file is Tofu's addition; it is not part of upstream Kutt.
//
// What a copy of Kutt needs on Tofu that upstream Kutt does not do by itself:
//   - read its database from DATABASE_URL, the one setting Tofu gives an app its database with (applyDatabaseUrl);
//   - derive JWT_SECRET from DATABASE_URL when the owner set none, so a copy starts with nothing set by hand
//     (deriveJwtSecret);
//   - take DEFAULT_DOMAIN as an address (https://...) as well as a bare host (normalizeDefaultDomain);
//   - connect over TLS the way DATABASE_URL's sslmode asks, checked against DB_SSL_CA when there is one
//     (databaseSsl);
//   - let only the copy's owner create its first account, the administrator, with ADMIN_SETUP_PASSWORD
//     (checkAdminSetupPassword);
//   - turn row-level security on for Kutt's own tables on a Supabase database (protectTablesFromDataApi).
// It requires nothing of Kutt's own, so server/env.js can use it before Kutt's settings are read.
const { createHash, timingSafeEqual } = require("node:crypto");

const isSet = value => typeof value === "string" && value !== "";

function decode(component) {
  try {
    return decodeURIComponent(component);
  } catch {
    return component;
  }
}

// libpq's sslmode -> DB_SSL and DB_SSL_REJECT_UNAUTHORIZED. node-postgres does not fall back between a plain and an
// encrypted connection the way libpq's "allow" and "prefer" do, so each of those two is read as its first try.
const SSL_MODES = {
  disable: ["false", undefined],
  allow: ["false", undefined],
  prefer: ["true", "false"],
  require: ["true", "false"],
  "no-verify": ["true", "false"],
  "verify-ca": ["true", "true"],
  "verify-full": ["true", "true"],
};

// Fills Kutt's DB_* settings from DATABASE_URL (postgres:// or postgresql://): Kutt has no setting that takes a URL.
// A DB_* setting that is already set is kept as it is. DB_SSL_CA is filled from SUPABASE_CA_CERT, the database's
// certificate, which Tofu saves beside DATABASE_URL.
function applyDatabaseUrl(environment) {
  if (!isSet(environment.DATABASE_URL)) return;

  let url;
  try {
    url = new URL(environment.DATABASE_URL);
  } catch {
    url = null;
  }
  if (!url || (url.protocol !== "postgres:" && url.protocol !== "postgresql:")) {
    console.warn("> DATABASE_URL is not a postgres:// URL, so the DB_* settings are left as they are");
    return;
  }

  const [ssl, rejectUnauthorized] = SSL_MODES[url.searchParams.get("sslmode")] || [];
  const values = {
    DB_CLIENT: "pg",
    DB_HOST: url.hostname.replace(/^\[(.*)\]$/, "$1"),
    DB_PORT: url.port,
    DB_NAME: decode(url.pathname.replace(/^\//, "")),
    DB_USER: decode(url.username),
    DB_PASSWORD: decode(url.password),
    DB_SSL: ssl,
    DB_SSL_REJECT_UNAUTHORIZED: rejectUnauthorized,
    DB_SSL_CA: environment.SUPABASE_CA_CERT,
  };
  for (const [key, value] of Object.entries(values)) {
    if (!isSet(environment[key]) && isSet(value)) environment[key] = value;
  }
}

// JWT_SECRET signs every sign-in cookie, and Kutt does not start in production without one. When it is not set and
// DATABASE_URL is, it is the SHA-256 of "kutt-jwt-secret:" followed by the whole DATABASE_URL, as 64 hex characters,
// so it is only as secret as DATABASE_URL. A JWT_SECRET the owner sets always wins.
function deriveJwtSecret(environment) {
  if (isSet(environment.JWT_SECRET) || !isSet(environment.DATABASE_URL)) return;
  environment.JWT_SECRET = createHash("sha256")
    .update("kutt-jwt-secret:" + environment.DATABASE_URL)
    .digest("hex");
}

// Kutt's DEFAULT_DOMAIN is a host ("kutt.to"), and every short link is built as https://<DEFAULT_DOMAIN>/<address>.
// Tofu's gallery saves a copy's own address as https://<name>.trytofu.app, so an address is read as its host.
function normalizeDefaultDomain(environment) {
  const value = environment.DEFAULT_DOMAIN;
  if (!isSet(value) || !value.includes("://")) return;
  try {
    environment.DEFAULT_DOMAIN = new URL(value).host;
  } catch {
    // Not an address after all: left as it is.
  }
}

// The TLS option for node-postgres. Upstream passes DB_SSL as it is, and `ssl: true` makes node-postgres check the
// server's certificate against Node's own list of authorities, which a managed database's pooler does not pass
// (SELF_SIGNED_CERT_IN_CHAIN). With DB_SSL_CA (PEM text, or its base64) the certificate is checked against that one;
// without it, DB_SSL_REJECT_UNAUTHORIZED=false encrypts the connection without checking, as sslmode=require does.
function databaseSsl(env) {
  if (!env.DB_SSL) return false;
  if (env.DB_SSL_CA) {
    const ca = env.DB_SSL_CA.includes("-----BEGIN")
      ? env.DB_SSL_CA
      : Buffer.from(env.DB_SSL_CA, "base64").toString("utf8");
    return { ca };
  }
  return env.DB_SSL_REJECT_UNAUTHORIZED ? true : { rejectUnauthorized: false };
}

// The first account a new Kutt makes is its administrator, on the /create-admin page, and a copy is online at a public
// address before its owner first opens it. So that page only completes for someone who also types ADMIN_SETUP_PASSWORD,
// a hidden value the owner saves on the app's Keys & settings page; without that setting, nobody can make the account.
// Wrong answers are counted for the whole server, not per visitor: ten in ten minutes, and it waits.
const ADMIN_SETUP_MIN_LENGTH = 12;
const ADMIN_SETUP_WINDOW_MS = 10 * 60 * 1000;
const ADMIN_SETUP_MAX_FAILURES = 10;
const adminSetupFailures = [];

// "missing", "short" (fewer than 12 characters) or "ready".
function adminSetupState(expected) {
  if (!isSet(expected)) return "missing";
  if (expected.length < ADMIN_SETUP_MIN_LENGTH) return "short";
  return "ready";
}

// Null when `given` is the setup password, otherwise why not: "missing" or "short" (the owner's setting), "too_many"
// or "wrong".
function checkAdminSetupPassword(expected, given) {
  const state = adminSetupState(expected);
  if (state !== "ready") return state;

  const now = Date.now();
  while (adminSetupFailures.length && now - adminSetupFailures[0] > ADMIN_SETUP_WINDOW_MS) {
    adminSetupFailures.shift();
  }
  if (adminSetupFailures.length >= ADMIN_SETUP_MAX_FAILURES) return "too_many";

  const digest = value => createHash("sha256").update(value).digest();
  if (typeof given === "string" && timingSafeEqual(digest(expected), digest(given))) return null;

  adminSetupFailures.push(now);
  return "wrong";
}

const ADMIN_SETUP_REFUSALS = {
  missing: {
    status: 403,
    message: "This copy's owner has to save ADMIN_SETUP_PASSWORD first, as a hidden value on the app's Keys & settings page, and deploy again.",
  },
  short: {
    status: 403,
    message: "ADMIN_SETUP_PASSWORD is shorter than 12 characters. This copy's owner has to save a longer one and deploy again.",
  },
  too_many: {
    status: 429,
    message: "Too many wrong setup passwords. Wait 10 minutes, then try again.",
  },
  wrong: {
    status: 401,
    message: "The setup password is not correct.",
  },
};

function adminSetupRefusal(reason) {
  return ADMIN_SETUP_REFUSALS[reason] || ADMIN_SETUP_REFUSALS.wrong;
}

// Kutt's own tables, and knex's record of the migrations it ran.
const KUTT_TABLES = ["users", "ips", "domains", "hosts", "links", "visits", "knex_migrations", "knex_migrations_lock"];

// Tofu's databases are Supabase PostgreSQL. On a database whose default privileges still give every new table in public
// to the Data API's roles (anon and authenticated), anyone with the project's public key could read and change Kutt's
// tables through the Data API: users, with password hashes and API keys, included. With row-level security on and no
// policy, those roles see no row. Kutt's own connection owns the tables, so row-level security does not limit it.
// This runs at every start, never turns row-level security off, touches no other table, and does nothing on a
// database without those roles. On a failure Kutt logs a warning and starts anyway.
async function protectTablesFromDataApi(knex) {
  try {
    const roles = await knex.raw(
      "select count(*)::int as found from pg_roles where rolname in ('anon', 'authenticated')"
    );
    if (roles.rows[0].found < 2) return;

    const tables = await knex.raw(
      `select c.relname as name
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
          and pg_has_role(c.relowner, 'USAGE')
          and c.relname in (${KUTT_TABLES.map(() => "?").join(", ")})`,
      KUTT_TABLES
    );
    for (const { name } of tables.rows) {
      await knex.transaction(async trx => {
        await trx.raw("set local lock_timeout = '5s'");
        await trx.raw("alter table ?? enable row level security", [`public.${name}`]);
      });
    }
    if (tables.rows.length) {
      console.log(`> Turned on row-level security on ${tables.rows.length} of Kutt's tables for Supabase's Data API`);
    }
  } catch (error) {
    console.warn("> Could not turn on row-level security on Kutt's tables:", error.message);
  }
}

module.exports = {
  adminSetupRefusal,
  adminSetupState,
  applyDatabaseUrl,
  checkAdminSetupPassword,
  databaseSsl,
  deriveJwtSecret,
  normalizeDefaultDomain,
  protectTablesFromDataApi,
};
