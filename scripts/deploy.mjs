#!/usr/bin/env node
/**
 * Deploy wrapper that gracefully skips Sentry steps when unconfigured.
 *
 * Sentry is "configured" if either .sentryclirc exists OR SENTRY_AUTH_TOKEN is set,
 * AND SENTRY_ORG + SENTRY_PROJECT are resolvable (env or .sentryclirc).
 *
 * Without Sentry: `wrangler deploy` runs normally. With Sentry: we tag the
 * release, upload sourcemaps to Sentry, and inject SENTRY_RELEASE so runtime
 * events get linked to the release.
 */
import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const SENTRY_ORG = process.env.SENTRY_ORG ?? "flicker-ventures";
const SENTRY_PROJECT = process.env.SENTRY_PROJECT ?? "bluedot-worker";

const hasSentry = existsSync(".sentryclirc") || Boolean(process.env.SENTRY_AUTH_TOKEN);

function run(cmd, opts = {}) {
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: "inherit", ...opts });
}

function tryProposeRelease() {
  const res = spawnSync("npx", ["sentry-cli", "releases", "propose-version"], { encoding: "utf8" });
  if (res.status !== 0) return null;
  return res.stdout.trim() || null;
}

let release = null;
if (hasSentry) {
  release = tryProposeRelease();
  if (!release) {
    console.warn("[deploy] sentry-cli propose-version failed — continuing without release tag");
  }
}

const deployArgs = ["wrangler deploy", "--outdir dist", "--upload-source-maps"];
if (release) deployArgs.push(`--var SENTRY_RELEASE:${release}`);
run(deployArgs.join(" "));

if (hasSentry && release) {
  try {
    run(`npx sentry-cli releases new ${release} --org=${SENTRY_ORG} --project=${SENTRY_PROJECT}`);
    run(`npx sentry-cli sourcemaps upload --org=${SENTRY_ORG} --project=${SENTRY_PROJECT} --release=${release} --strip-prefix 'dist/..' dist`);
    run(`npx sentry-cli releases finalize ${release} --org=${SENTRY_ORG} --project=${SENTRY_PROJECT}`);
  } catch (err) {
    console.warn(`[deploy] Sentry sourcemap upload failed: ${err.message}`);
    console.warn("[deploy] Deployment succeeded; source maps not uploaded.");
  }
} else {
  console.log("[deploy] Skipping Sentry sourcemap upload (no .sentryclirc or SENTRY_AUTH_TOKEN).");
}
