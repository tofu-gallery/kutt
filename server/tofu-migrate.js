// Tofu (2026-10-26): this file is Tofu's addition; it is not part of upstream Kutt.
//
// Kutt's schema step, which the image's CMD runs before `npm start` in place of upstream's `npm run migrate`
// (`knex migrate:latest`): the same migrations from the same knexfile.js, and on PostgreSQL row-level security for
// Kutt's tables, with only one start at a time doing it (server/tofu.js, prepareDatabase). Exits with 1 if it fails.
const path = require("node:path");

const config = require("../knexfile");
const tofu = require("./tofu");

const knex = require("knex")(config);
const isPostgres = config.client === "pg" || config.client === "pg-native";

tofu
  .prepareDatabase(knex, {
    isPostgres,
    migrations: { ...config.migrations, directory: path.join(__dirname, "migrations") },
  })
  .then(
    () => knex.destroy(),
    async error => {
      console.error("> Kutt's schema step failed:", error.message);
      process.exitCode = 1;
      await knex.destroy().catch(() => {});
    }
  );
