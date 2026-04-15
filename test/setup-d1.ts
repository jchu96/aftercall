import { env, applyD1Migrations } from "cloudflare:test";

/**
 * Auto-load every `drizzle/*.sql` migration at test time so tests run
 * against the actual production schema. Vite's `import.meta.glob` picks
 * up new migrations as they're added — no manual list to maintain.
 *
 * Migrations are processed in alphabetical filename order (Drizzle uses
 * `0000_`, `0001_`, ... numeric prefixes).
 */
const migrationFiles = import.meta.glob<string>(
  "../drizzle/*.sql",
  { eager: true, query: "?raw", import: "default" },
);

const migrations = Object.entries(migrationFiles)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([path, sql]) => {
    const name = path.split("/").pop()!.replace(/\.sql$/, "");
    // Drizzle separates statements with `--> statement-breakpoint`
    const queries = sql
      .split("--> statement-breakpoint")
      .map((q) => q.trim())
      .filter((q) => q.length > 0);
    return { name, queries };
  });

/**
 * Apply migrations + clear the transcripts table before every test.
 *
 * Vitest-pool-workers gives each test a fresh D1 isolate, so we apply
 * migrations on every call. `applyD1Migrations` is idempotent via its
 * internal `d1_migrations` ledger — safe even if the DB persisted.
 */
export async function setupD1(): Promise<void> {
  await applyD1Migrations(env.DB, migrations);
  await env.DB.exec("DELETE FROM transcripts");
}
