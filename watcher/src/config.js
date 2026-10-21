import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

const REQUIRED_PATHS = [
  "stateFile",
  "businessHours.timeZone",
  "businessHours.days",
  "businessHours.start",
  "businessHours.end",
  "issueKeyPattern",
  "github.boardLogin",
  "github.factoryBranchPrefix",
  "github.botLogins",
  "github.agentMarkers",
  "github.ignoredChecks",
  "github.ignoredBodyPatterns",
  "github.agentPhrasePatterns",
  "paperclip.boardUserId",
  "paperclip.boardUserName",
  "paperclip.uiBaseUrl",
  "paperclip.approvalPatterns",
  "paperclip.agents.developer",
  "paperclip.agents.reviewer",
  "paperclip.agents.qa",
  "paperclip.agents.onCall",
  "paperclip.agents.headOfProduct",
  "paperclip.projects.productionMonitoring",
  "paperclip.projects.discovery",
  "ledger.seedMergedSince",
  "board.approvalCap",
  "board.rewriteMinutes",
  "board.stuckHours",
  "repos",
];

function valueAt(object, path) {
  return path.split(".").reduce((value, key) => (value == null ? undefined : value[key]), object);
}

export function validateConfig(config) {
  const missing = REQUIRED_PATHS.filter((path) => valueAt(config, path) === undefined);
  if (missing.length) throw new Error(`config is missing: ${missing.join(", ")}`);
  if (!isAbsolute(config.stateFile)) throw new Error("config.stateFile must be an absolute path");
  for (const repo of config.repos) {
    for (const field of ["name", "github", "projectId", "baseBranch", "deploy"]) {
      if (repo[field] === undefined) throw new Error(`config.repos entry ${repo.name ?? "?"} is missing ${field}`);
    }
  }
  return config;
}

export async function loadConfig(path) {
  return validateConfig(JSON.parse(await readFile(path, "utf8")));
}
