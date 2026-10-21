import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const STATE_VERSION = 1;

export function emptyState(now) {
  return {
    version: STATE_VERSION,
    baselineAt: now.toISOString(),
    lastTickAt: null,
    prs: {},
    paperclipComments: {},
    ledger: {},
    deploys: {},
    markers: {},
    board: { writtenAt: null, dailySummaryDate: null, dailySnapshot: null },
  };
}

export async function loadState(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const state = JSON.parse(text);
  if (state.version !== STATE_VERSION) {
    throw new Error(`state file ${path} has version ${state.version}, expected ${STATE_VERSION}`);
  }
  return state;
}

export async function saveState(path, state) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`);
  await rename(temporary, path);
}
