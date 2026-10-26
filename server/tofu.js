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
//   - turn row-level security on for Kutt's own tables on a Supabase database (protectTablesFromDataApi);
//   - run the migrations and that as one step that only one start at a time takes (prepareDatabase, 2026-10-26).
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
// Tofu (2026-10-26): this now runs inside the schema step's transaction (prepareDatabase), so on a new database the
// tables are never committed without it. It never turns row-level security off, touches no other table, and does
// nothing on a database without those roles. Two round trips: the list, then every change in one batch. Returns how
// many tables it changed.
async function protectTablesFromDataApi(db) {
  const tables = await db.raw(
    `select c.relname as name
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
        and pg_has_role(c.relowner, 'USAGE')
        and c.relname in (${KUTT_TABLES.map(() => "?").join(", ")})
        and (select count(*) from pg_roles where rolname in ('anon', 'authenticated')) = 2`,
    KUTT_TABLES
  );
  const names = tables.rows.map(row => row.name).filter(name => KUTT_TABLES.includes(name));
  if (!names.length) return 0;
  // A table some other connection is using is waited for at most 5 seconds; then the step fails and the start with it.
  await db.raw(
    ["set local lock_timeout = '5s'", ...names.map(name => `alter table public."${name}" enable row level security`)]
      .join(";\n")
  );
  return names.length;
}

// Tofu (2026-10-26): Kutt's schema step, run by server/tofu-migrate.js before the server starts. Tofu's container
// hosting can start the app several times within a second or two, on a new database too, and every start runs the
// migrations. knex keeps its migration lock as a row in knex_migrations_lock, but makes that table and that row before
// it takes the lock, so on an empty database the starts collide while making them ("duplicate key value violates
// unique constraint pg_class_relname_nsp_index") and every start but one exits.
//
// On PostgreSQL the whole step is one transaction that takes a transaction-level advisory lock before it reads or
// changes anything (only the two SET LOCALs that bound the wait come first): knex's own tables, every migration (knex
// runs them in this transaction), and row-level security for Kutt's tables. A start that finds the lock taken waits for
// it (at most SCHEMA_LOCK_WAIT; statement_timeout is raised above that for this transaction, so a role's own timeout
// does not cut the wait shorter), and then reads the database again inside the lock: knex lists the migrations already
// run, and a start after the first finds nothing left to do.
//
// DATABASE_URL is Tofu's transaction pooler (port 6543), which lends a client one server connection for each
// transaction: a lock taken inside the transaction is held by that server connection until COMMIT or ROLLBACK, and
// PostgreSQL's DDL is transactional, so other starts see either nothing or all of the work. A session-level lock
// (pg_advisory_lock) would stay with a server connection the pooler then lends to other clients, so it is not used.
const SCHEMA_LOCK_KEY = 1802859636; // 0x6b757474, "kutt" in ASCII: the same number in every start
const SCHEMA_LOCK_WAIT = "120s";
const SCHEMA_STATEMENT_LIMIT = "150s";
// Another start's object met anyway (only possible if something outside this lock changes the schema at the same
// time): the whole step runs once more.
const DUPLICATE_OBJECT_CODES = new Set(["42P07", "42710", "42701", "42P06", "42723", "23505"]);

async function prepareDatabase(knex, { isPostgres, migrations }) {
  if (!isPostgres) {
    reportMigrations(await knex.migrate.latest(migrations));
    return;
  }
  for (let attempt = 1; ; attempt++) {
    try {
      const { migrated, waitedMs, protectedTables } = await knex.transaction(async trx => {
        // One round trip; the lock is asked for in the next one, so the raised statement_timeout already applies to it.
        await trx.raw(
          `set local lock_timeout = '${SCHEMA_LOCK_WAIT}'; set local statement_timeout = '${SCHEMA_STATEMENT_LIMIT}'`
        );
        const asked = Date.now();
        await trx.raw("select pg_advisory_xact_lock(?)", [SCHEMA_LOCK_KEY]);
        const waitedMs = Date.now() - asked;
        const migrated = await trx.migrate.latest(migrations);
        const protectedTables = await protectTablesFromDataApi(trx);
        return { migrated, waitedMs, protectedTables };
      });
      if (waitedMs >= 1000) {
        console.log(`> Waited ${(waitedMs / 1000).toFixed(1)} s while another start prepared the database`);
      }
      reportMigrations(migrated);
      if (protectedTables) {
        console.log(`> Turned on row-level security on ${protectedTables} of Kutt's tables for Supabase's Data API`);
      }
      return;
    } catch (error) {
      if (attempt > 1 || !DUPLICATE_OBJECT_CODES.has(error.code)) throw error;
      console.warn(`> The schema step met an object made elsewhere (${error.code}); running it once more`);
    }
  }
}

function reportMigrations([batchNo, log]) {
  console.log(log.length ? `> Batch ${batchNo} run: ${log.length} migrations` : "> Already up to date");
}

module.exports = {
  adminSetupRefusal,
  adminSetupState,
  applyDatabaseUrl,
  checkAdminSetupPassword,
  databaseSsl,
  deriveJwtSecret,
  normalizeDefaultDomain,
  prepareDatabase,
  protectTablesFromDataApi,
};
