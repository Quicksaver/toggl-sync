#!/usr/bin/env node
import { confirm, select } from "@inquirer/prompts";

import { CONFIG_PATH, loadConfig, saveConfig } from "./config.js";
import {
  buildCreateTimeEntryInput,
  computeSummary,
  entryWorkspaceId,
  filterEntriesAlreadyInTarget,
  fingerprintTimeEntry,
  formatDuration,
  gatherSourceProjectRequirements,
  initialStartDate,
  latestCopiedEntry,
  missingProjectMappings,
  selectEntriesToCopy,
  sourceProjectKey,
  usableTargetProjects,
  verifyLatestCopiedTarget,
} from "./sync.js";
import { TogglApiError, TogglClient } from "./toggl.js";
import type { AccountConfig, SyncConfig, TogglProject, TogglWorkspace } from "./types.js";

const WRITE_DELAY_MS = 1_100;

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function workspaceLabel(workspace: TogglWorkspace): string {
  return workspace.organization_name
    ? `${workspace.name} — ${workspace.organization_name}`
    : workspace.name;
}

function projectLabel(project: TogglProject): string {
  return project.client_name ? `${project.name} — ${project.client_name}` : project.name;
}

async function resolveWorkspace(
  label: "FROM ACCOUNT" | "TO ACCOUNT",
  accountConfig: AccountConfig,
  client: TogglClient,
  config: SyncConfig,
): Promise<number> {
  const workspaces = await client.getWorkspaces();
  if (workspaces.length === 0) throw new Error(`${label} has no accessible workspaces.`);

  if (accountConfig.workspaceId !== null) {
    const configured = workspaces.find((workspace) => workspace.id === accountConfig.workspaceId);
    if (!configured) {
      throw new Error(
        `${label} workspace ${accountConfig.workspaceId} is not accessible with its configured token.`,
      );
    }
    return configured.id;
  }

  const selectedId =
    workspaces.length === 1
      ? workspaces[0]!.id
      : await select({
          message: `Select the ${label} workspace`,
          choices: workspaces.map((workspace) => ({
            name: workspaceLabel(workspace),
            value: workspace.id,
            description: `Workspace ID ${workspace.id}`,
          })),
        });

  accountConfig.workspaceId = selectedId;
  await saveConfig(config);
  return selectedId;
}

async function ensureProjectMappings(
  config: SyncConfig,
  requirements: ReturnType<typeof gatherSourceProjectRequirements>,
  targetProjects: TogglProject[],
): Promise<void> {
  const usableProjects = usableTargetProjects(targetProjects);
  if (usableProjects.length === 0) {
    throw new Error("TO ACCOUNT has no active projects that can receive time entries.");
  }

  let missing = missingProjectMappings(requirements, usableProjects, config);
  for (const [index, requirement] of missing.entries()) {
    const targetProjectId = await select({
      message: `Map FROM PROJECT “${requirement.name}” (${requirement.entryCount} entries) [${index + 1}/${missing.length}]`,
      pageSize: Math.min(15, usableProjects.length),
      choices: usableProjects.map((project) => ({
        name: projectLabel(project),
        value: project.id,
        description: `Project ID ${project.id}`,
      })),
    });
    const targetProject = usableProjects.find((project) => project.id === targetProjectId)!;
    config.projectMappings[requirement.key] = {
      fromProjectName: requirement.name,
      toProjectId: targetProject.id,
      toProjectName: targetProject.name,
    };
    await saveConfig(config);
  }

  missing = missingProjectMappings(requirements, usableProjects, config);
  if (missing.length > 0) {
    throw new Error(`Cannot continue: ${missing.length} source projects are not mapped.`);
  }
}

function printSummary(summary: ReturnType<typeof computeSummary>): void {
  const decimalHours = (summary.durationSeconds / 3600).toFixed(2);
  console.log("\nReady to copy:");
  console.log(`  ${summary.entryCount} entries`);
  console.log(
    `  ${summary.sourceProjectCount} FROM projects → ${summary.targetProjectCount} TO projects`,
  );
  console.log(`  ${decimalHours} hours (${formatDuration(summary.durationSeconds)})`);
  console.log(
    `  ${summary.earliestStart.slice(0, 10)} → ${summary.latestStart.slice(0, 10)}`,
  );
  if (summary.runningEntriesSkipped > 0) {
    console.log(`  ${summary.runningEntriesSkipped} running entries skipped`);
  }
  if (summary.alreadyCopiedSkipped > 0) {
    console.log(`  ${summary.alreadyCopiedSkipped} previously copied entries ignored`);
  }
  if (summary.alreadyPresentInTargetSkipped > 0) {
    console.log(`  ${summary.alreadyPresentInTargetSkipped} matching TO entries ignored`);
  }
}

async function run(): Promise<void> {
  const config = await loadConfig();
  const fromClient = new TogglClient(config.from.apiToken, "FROM ACCOUNT");
  const toClient = new TogglClient(config.to.apiToken, "TO ACCOUNT");

  console.log("Connecting to Toggl…");
  const fromWorkspaceId = await resolveWorkspace("FROM ACCOUNT", config.from, fromClient, config);
  const toWorkspaceId = await resolveWorkspace("TO ACCOUNT", config.to, toClient, config);
  if (fromWorkspaceId === toWorkspaceId && config.from.apiToken === config.to.apiToken) {
    throw new Error("FROM and TO resolve to the same account and workspace.");
  }

  const newestCopy = latestCopiedEntry(config.copiedEntries);
  let startDate: string;
  if (newestCopy) {
    const targetEntry = await toClient.getTimeEntry(newestCopy.targetEntryId);
    verifyLatestCopiedTarget(newestCopy, targetEntry, toWorkspaceId);
    startDate = newestCopy.sourceStart;
    console.log(`Verified sync cursor at ${newestCopy.sourceStart}.`);
  } else {
    startDate = initialStartDate(new Date());
    console.log("First run: scanning the last 60 days.");
  }

  const endDate = new Date(Date.now() + 1_000).toISOString();
  const [fetchedEntries, sourceProjects, targetProjects] = await Promise.all([
    fromClient.getTimeEntries(startDate, endDate),
    fromClient.getProjects(fromWorkspaceId),
    toClient.getProjects(toWorkspaceId),
  ]);
  const { entries: gatheredEntries, runningEntriesSkipped, alreadyCopiedSkipped } = selectEntriesToCopy(
    fetchedEntries,
    fromWorkspaceId,
    config.copiedEntries,
  );

  if (gatheredEntries.length === 0) {
    console.log("Nothing new to copy.");
    if (runningEntriesSkipped > 0) {
      console.log(`${runningEntriesSkipped} running entries were skipped.`);
    }
    return;
  }

  const requirements = gatherSourceProjectRequirements(gatheredEntries, sourceProjects);
  await ensureProjectMappings(config, requirements, targetProjects);

  console.log("Checking mapped entries already present in TO ACCOUNT…");
  const targetEntries = await toClient.getTimeEntries(gatheredEntries[0]!.start, endDate);
  const { entries, alreadyPresentInTargetSkipped } = filterEntriesAlreadyInTarget(
    gatheredEntries,
    targetEntries,
    toWorkspaceId,
    config,
  );
  if (entries.length === 0) {
    console.log(
      `Nothing new to copy. ${alreadyPresentInTargetSkipped} matching entries already exist in TO ACCOUNT.`,
    );
    return;
  }

  const summary = computeSummary(
    entries,
    config,
    runningEntriesSkipped,
    alreadyCopiedSkipped,
    alreadyPresentInTargetSkipped,
  );
  printSummary(summary);
  const approved = await confirm({ message: "Continue with the copy?", default: false });
  if (!approved) {
    console.log("Cancelled. No entries were copied.");
    return;
  }

  console.log("");
  for (const [index, sourceEntry] of entries.entries()) {
    const key = sourceProjectKey(sourceEntry);
    const mapping = config.projectMappings[key];
    if (!mapping) throw new Error(`Project mapping disappeared for ${key}.`);

    const input = buildCreateTimeEntryInput(sourceEntry, toWorkspaceId, mapping.toProjectId);
    const targetEntry = await toClient.createTimeEntry(toWorkspaceId, input);
    if (!Number.isInteger(targetEntry.id) || entryWorkspaceId(targetEntry) !== toWorkspaceId) {
      throw new Error(`TO ACCOUNT returned an invalid entry after copying source ${sourceEntry.id}.`);
    }

    config.copiedEntries.push({
      sourceEntryId: sourceEntry.id,
      targetEntryId: targetEntry.id,
      sourceStart: sourceEntry.start,
      sourceProjectKey: key,
      targetProjectId: mapping.toProjectId,
      fingerprint: fingerprintTimeEntry(targetEntry),
      copiedAt: new Date().toISOString(),
    });
    await saveConfig(config);
    console.log(`[${index + 1}/${entries.length}] copied ${sourceEntry.start} — ${mapping.toProjectName}`);
    if (index < entries.length - 1) await sleep(WRITE_DELAY_MS);
  }

  console.log(`\nCopied ${entries.length} entries successfully.`);
}

run().catch((error: unknown) => {
  if (error instanceof TogglApiError) {
    console.error(`\n${error.message}`);
  } else if (error instanceof Error) {
    console.error(`\n${error.message}`);
  } else {
    console.error("\nUnknown error.");
  }
  console.error(`Config: ${CONFIG_PATH}`);
  process.exitCode = 1;
});
