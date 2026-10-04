#!/usr/bin/env node
// Workers Builds entry point for abot-sms. This is the only supported deploy path.
//
// Dashboard configuration (Workers & Pages > abot-sms > Settings > Builds):
//   Build command:  node deploy/cloudflare.mjs build
//   Deploy command: node deploy/cloudflare.mjs deploy
//   Branch:         main (preview builds disabled)
//
// `build` runs anywhere and only verifies. `deploy` refuses to run outside a
// Workers Builds production build of `main`.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRODUCTION_BRANCH = "main";
const WORKER_NAME = "abot-sms";

function fail(message) {
  console.error(`[cloudflare] ${message}`);
  process.exit(1);
}

function run(command, args) {
  console.log(`[cloudflare] $ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd: ROOT, stdio: "inherit" });
  if (result.error) fail(`${command} failed to start: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} ${args[0] ?? ""} exited with ${result.status}`);
}

function stripJsonc(text) {
  return text
    .replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_m, str) => str ?? "")
    .replace(/,(\s*[}\]])/g, "$1");
}

function checkWranglerConfig() {
  const config = JSON.parse(stripJsonc(readFileSync(path.join(ROOT, "wrangler.jsonc"), "utf8")));
  const problems = [];
  if (config.name !== WORKER_NAME) problems.push(`name must be "${WORKER_NAME}"`);
  if (config.workers_dev !== false) problems.push("workers_dev must be false");
  if (config.preview_urls !== false) problems.push("preview_urls must be false");
  if (config.routes || config.route) problems.push("routes are not allowed; abot-gateway is the only entry point");
  if (config.env) problems.push("named environments are not allowed; main deploys the single production Worker");
  const required = config.secrets?.required ?? [];
  for (const name of ["AIR_BROKER_URL", "AIR_BROKER_ACCESS_CODE"]) {
    if (!required.includes(name)) problems.push(`secrets.required must list ${name}`);
  }
  if (config.vars && Object.keys(config.vars).some((key) => key.startsWith("AIR_BROKER_"))) {
    problems.push("AIR_BROKER_* values must be secrets, not vars");
  }
  if (problems.length) fail(`wrangler.jsonc is unsafe to deploy:\n  - ${problems.join("\n  - ")}`);
  console.log("[cloudflare] wrangler.jsonc checks passed");
}

function build() {
  checkWranglerConfig();
  run("npx", ["tsc", "--noEmit"]);
  run("npx", ["vitest", "run"]);
  run("npx", ["wrangler", "deploy", "--dry-run", "--outdir", "dist"]);
}

function deploy() {
  if (process.env.WORKERS_CI !== "1") {
    fail("deploy only runs inside Cloudflare Workers Builds. Push to main instead of deploying by hand.");
  }
  const branch = process.env.WORKERS_CI_BRANCH;
  if (branch !== PRODUCTION_BRANCH) {
    fail(`deploy only runs for ${PRODUCTION_BRANCH}; this build is for "${branch ?? "unknown"}".`);
  }
  checkWranglerConfig();
  const sha = process.env.WORKERS_CI_COMMIT_SHA ?? "unknown";
  const buildId = process.env.WORKERS_CI_BUILD_UUID ?? "unknown";
  run("npx", [
    "wrangler",
    "deploy",
    "--message",
    `workers-builds ${buildId} ${branch}@${sha.slice(0, 12)}`,
    "--tag",
    sha.slice(0, 12),
  ]);
}

const command = process.argv[2];
if (command === "build") build();
else if (command === "deploy") deploy();
else fail("usage: node deploy/cloudflare.mjs <build|deploy>");
