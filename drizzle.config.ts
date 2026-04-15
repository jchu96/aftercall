import type { Config } from "drizzle-kit";

export default {
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  driver: "d1-http",
  // d1-http creds only needed for `migrate`; `generate` works without them
} satisfies Config;
