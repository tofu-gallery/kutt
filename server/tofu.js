// Tofu (2026-10-25): this file is Tofu's addition; it is not part of upstream Kutt.
//
// What a copy of Kutt needs on Tofu that upstream Kutt does not do by itself:
//   - read its database from DATABASE_URL, the one setting Tofu gives an app its database with (applyDatabaseUrl);
//   - derive JWT_SECRET from DATABASE_URL when the owner set none, so a copy starts with nothing set by hand
//     (deriveJwtSecret);
//   - take DEFAULT_DOMAIN as an address (https://...) as well as a bare host (normalizeDefaultDomain);
//   - connect over TLS the way DATABASE_URL's sslmode asks, checked against DB_SSL_CA when there is one
//     (databaseSsl).
// It requires nothing of Kutt's own, so server/env.js can use it before Kutt's settings are read.
const { createHash } = require("node:crypto");

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

module.exports = {
  applyDatabaseUrl,
  databaseSsl,
  deriveJwtSecret,
  normalizeDefaultDomain,
};
