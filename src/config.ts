import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { SyncConfig } from "./types.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const CONFIG_PATH = path.join(projectRoot, "toggl-sync.config.json");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateAccount(value: unknown, label: string): void {
  if (!isRecord(value) || typeof value.apiToken !== "string") {
    throw new Error(`${label} must contain an apiToken string.`);
  }
  if (value.workspaceId !== null && !Number.isInteger(value.workspaceId)) {
    throw new Error(`${label}.workspaceId must be an integer or null.`);
  }
}

export function validateConfig(value: unknown): asserts value is SyncConfig {
  if (!isRecord(value) || value.version !== 1) {
    throw new Error("Config must be an object with version 1.");
  }
  validateAccount(value.from, "from");
  validateAccount(value.to, "to");
  if (!isRecord(value.projectMappings)) {
    throw new Error("projectMappings must be an object.");
  }
  if (!Array.isArray(value.copiedEntries)) {
    throw new Error("copiedEntries must be an array.");
  }
}

export function validateTokens(config: SyncConfig): void {
  const placeholders = ["", "PASTE_FROM_ACCOUNT_API_TOKEN_HERE", "PASTE_TO_ACCOUNT_API_TOKEN_HERE"];
  if (placeholders.includes(config.from.apiToken.trim())) {
    throw new Error(`Set from.apiToken in ${CONFIG_PATH}.`);
  }
  if (placeholders.includes(config.to.apiToken.trim())) {
    throw new Error(`Set to.apiToken in ${CONFIG_PATH}.`);
  }
}

export async function loadConfig(): Promise<SyncConfig> {
  let raw: string;
  try {
    raw = await readFile(CONFIG_PATH, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `Missing ${CONFIG_PATH}. Copy toggl-sync.config.example.json to toggl-sync.config.json and add both API tokens.`,
      );
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${CONFIG_PATH} is not valid JSON.`);
  }

  validateConfig(parsed);
  validateTokens(parsed);
  return parsed;
}

export async function saveConfig(config: SyncConfig): Promise<void> {
  validateConfig(config);
  const temporaryPath = `${CONFIG_PATH}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, CONFIG_PATH);
  await chmod(CONFIG_PATH, 0o600);
}
