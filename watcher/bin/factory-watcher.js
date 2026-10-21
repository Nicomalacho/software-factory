#!/usr/bin/env node
import { parseArgs } from "node:util";
import { loadConfig } from "../src/config.js";
import { createGitHub } from "../src/github.js";
import { isBusinessHours } from "../src/hours.js";
import { createPaperclip } from "../src/paperclip.js";
import { runTick } from "../src/tick.js";

const USAGE = `usage: factory-watcher [--config <path>] [--state <path>] [--dry-run] [--ignore-hours]

  --config        config JSON (default: $FACTORY_WATCHER_CONFIG)
  --state         state file, overrides config.stateFile
  --dry-run       read everything live, print the actions, write nothing
  --ignore-hours  run outside business hours (manual runs only)`;

async function main() {
  const { values } = parseArgs({
    options: {
      config: { type: "string" },
      state: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "ignore-hours": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const configPath = values.config ?? process.env.FACTORY_WATCHER_CONFIG;
  if (!configPath) {
    console.error(USAGE);
    return 2;
  }
  const config = await loadConfig(configPath);
  if (values.state) config.stateFile = values.state;

  const now = new Date();
  if (!values["ignore-hours"] && !isBusinessHours(now, config.businessHours)) {
    console.log(`factory-watcher: outside business hours (${config.businessHours.timeZone}), nothing to do`);
    return 0;
  }

  for (const name of ["PAPERCLIP_API_URL", "PAPERCLIP_API_KEY", "PAPERCLIP_COMPANY_ID"]) {
    if (!process.env[name]) throw new Error(`${name} is not set`);
  }
  const paperclip = createPaperclip({
    apiUrl: process.env.PAPERCLIP_API_URL,
    apiKey: process.env.PAPERCLIP_API_KEY,
    companyId: process.env.PAPERCLIP_COMPANY_ID,
    runId: process.env.PAPERCLIP_RUN_ID,
    dryRun: values["dry-run"],
  });
  const result = await runTick({
    config,
    github: createGitHub(),
    paperclip,
    now,
    dryRun: values["dry-run"],
    log: (line) => console.log(line),
  });
  return result.ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`factory-watcher: ${error.message}`);
    process.exit(1);
  },
);
