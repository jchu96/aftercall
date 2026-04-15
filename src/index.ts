// Worker entry: OAuth-wrapped MCP + Bluedot webhook, wrapped in Sentry.
// When SENTRY_DSN is unset, Sentry is a no-op so forkers can run without it.
import * as Sentry from "@sentry/cloudflare";
import type { Env } from "./env";
import worker from "./mcp/index";

// OAuthProvider's fetch signature includes OAUTH_PROVIDER (added at runtime),
// which Env doesn't declare. Cast so withSentry accepts it — the env object
// Sentry passes through is unchanged, and OAuthProvider adds the helper internally.
export default Sentry.withSentry(
  (env: Env) => ({
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT ?? "production",
    release: env.SENTRY_RELEASE,
    tracesSampleRate: 0.2,
    sendDefaultPii: false,
    enabled: Boolean(env.SENTRY_DSN),
  }),
  worker as unknown as ExportedHandler<Env>,
);
