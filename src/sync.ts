import { createHash } from "node:crypto";

import type {
  CopiedEntryRecord,
  CreateTimeEntryInput,
  SourceProjectRequirement,
  SyncConfig,
  SyncSummary,
  TogglProject,
  TogglTimeEntry,
} from "./types.js";

export const INITIAL_LOOKBACK_DAYS = 60;
export const SYNC_TAG = "toggl-sync";
export const NO_PROJECT_KEY = "no-project";
export const DUPLICATE_START_TOLERANCE_SECONDS = 3;
export const DUPLICATE_DURATION_TOLERANCE_SECONDS = 3;

export function assertDistinctWorkspaces(
  fromWorkspaceId: number,
  toWorkspaceId: number,
): void {
  if (fromWorkspaceId === toWorkspaceId) {
    throw new Error("FROM and TO must be different workspaces.");
  }
}

export function entryWorkspaceId(entry: TogglTimeEntry): number | undefined {
  return entry.workspace_id ?? entry.wid;
}

export function entryProjectId(entry: TogglTimeEntry): number | null {
  return entry.project_id ?? entry.pid ?? null;
}

export function sourceProjectKey(entry: TogglTimeEntry): string {
  const projectId = entryProjectId(entry);
  return projectId === null ? NO_PROJECT_KEY : `project:${projectId}`;
}

export function isCompletedEntry(entry: TogglTimeEntry): boolean {
  return (
    entry.server_deleted_at == null &&
    entry.duration >= 0 &&
    typeof entry.stop === "string" &&
    entry.stop.length > 0
  );
}

export function gatherSourceProjectRequirements(
  entries: TogglTimeEntry[],
  sourceProjects: TogglProject[],
): SourceProjectRequirement[] {
  const projectNames = new Map(sourceProjects.map((project) => [project.id, project.name]));
  const requirements = new Map<string, SourceProjectRequirement>();

  for (const entry of entries) {
    const id = entryProjectId(entry);
    const key = sourceProjectKey(entry);
    const existing = requirements.get(key);
    if (existing) {
      existing.entryCount += 1;
      continue;
    }

    requirements.set(key, {
      key,
      id,
      name:
        id === null
          ? "No project"
          : (entry.project_name ?? projectNames.get(id) ?? `Project #${id}`),
      entryCount: 1,
    });
  }

  return [...requirements.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function usableTargetProjects(projects: TogglProject[]): TogglProject[] {
  return projects
    .filter((project) => project.active !== false && project.can_track_time !== false)
    .sort((left, right) => {
      const byName = left.name.localeCompare(right.name);
      return byName === 0 ? left.id - right.id : byName;
    });
}

export function missingProjectMappings(
  requirements: SourceProjectRequirement[],
  targetProjects: TogglProject[],
  config: SyncConfig,
): SourceProjectRequirement[] {
  const validTargetIds = new Set(targetProjects.map((project) => project.id));
  return requirements.filter((requirement) => {
    const mapping = config.projectMappings[requirement.key];
    return mapping === undefined || !validTargetIds.has(mapping.toProjectId);
  });
}

export function latestCopiedEntry(records: CopiedEntryRecord[]): CopiedEntryRecord | null {
  return (
    [...records].sort((left, right) => {
      const byStart = right.sourceStart.localeCompare(left.sourceStart);
      return byStart === 0 ? right.copiedAt.localeCompare(left.copiedAt) : byStart;
    })[0] ?? null
  );
}

function fingerprintFields(entry: TogglTimeEntry) {
  return {
    workspaceId: entryWorkspaceId(entry) ?? null,
    projectId: entryProjectId(entry),
    description: entry.description ?? "",
    start: entry.start,
    stop: entry.stop ?? null,
    duration: entry.duration,
    billable: entry.billable ?? false,
    tags: [...(entry.tags ?? [])].sort(),
  };
}

export function fingerprintTimeEntry(entry: TogglTimeEntry): string {
  return createHash("sha256").update(JSON.stringify(fingerprintFields(entry))).digest("hex");
}

export function verifyLatestCopiedTarget(
  record: CopiedEntryRecord,
  targetEntry: TogglTimeEntry,
  targetWorkspaceId: number,
): void {
  if (targetEntry.id !== record.targetEntryId) {
    throw new Error("The fetched TO ACCOUNT entry ID does not match the saved sync record.");
  }
  if (entryWorkspaceId(targetEntry) !== targetWorkspaceId) {
    throw new Error("The latest copied entry is no longer in the configured TO workspace.");
  }
  if (!(targetEntry.tags ?? []).includes(SYNC_TAG)) {
    throw new Error(
      `The latest copied entry is missing the reserved ${SYNC_TAG} tag; refusing to treat it as synced.`,
    );
  }
  if (fingerprintTimeEntry(targetEntry) !== record.fingerprint) {
    throw new Error(
      "The latest copied entry no longer matches its saved fingerprint; refusing to advance the sync cursor.",
    );
  }
}

export function selectEntriesToCopy(
  fetchedEntries: TogglTimeEntry[],
  sourceWorkspaceId: number,
  copiedRecords: CopiedEntryRecord[],
): {
  entries: TogglTimeEntry[];
  runningEntriesSkipped: number;
  alreadyCopiedSkipped: number;
} {
  const copiedSourceIds = new Set(copiedRecords.map((record) => record.sourceEntryId));
  const workspaceEntries = fetchedEntries.filter(
    (entry) => entryWorkspaceId(entry) === sourceWorkspaceId && entry.server_deleted_at == null,
  );
  const runningEntriesSkipped = workspaceEntries.filter((entry) => !isCompletedEntry(entry)).length;
  const completedEntries = workspaceEntries.filter(isCompletedEntry);
  const alreadyCopiedSkipped = completedEntries.filter((entry) => copiedSourceIds.has(entry.id)).length;
  const entries = completedEntries
    .filter((entry) => !copiedSourceIds.has(entry.id))
    .sort((left, right) => {
      const byStart = left.start.localeCompare(right.start);
      return byStart === 0 ? left.id - right.id : byStart;
    });

  return { entries, runningEntriesSkipped, alreadyCopiedSkipped };
}

function duplicateDistance(
  sourceEntry: TogglTimeEntry,
  targetEntry: TogglTimeEntry,
  targetProjectId: number,
): number | null {
  if (
    entryProjectId(targetEntry) !== targetProjectId ||
    (targetEntry.description ?? "") !== (sourceEntry.description ?? "")
  ) {
    return null;
  }

  const sourceStart = Date.parse(sourceEntry.start);
  const targetStart = Date.parse(targetEntry.start);
  if (!Number.isFinite(sourceStart) || !Number.isFinite(targetStart)) return null;

  const startDeltaSeconds = Math.abs(sourceStart - targetStart) / 1_000;
  const durationDeltaSeconds = Math.abs(sourceEntry.duration - targetEntry.duration);
  if (
    startDeltaSeconds > DUPLICATE_START_TOLERANCE_SECONDS ||
    durationDeltaSeconds > DUPLICATE_DURATION_TOLERANCE_SECONDS
  ) {
    return null;
  }

  return startDeltaSeconds + durationDeltaSeconds;
}

export function filterEntriesAlreadyInTarget(
  sourceEntries: TogglTimeEntry[],
  targetEntries: TogglTimeEntry[],
  targetWorkspaceId: number,
  config: SyncConfig,
): { entries: TogglTimeEntry[]; alreadyPresentInTargetSkipped: number } {
  const availableTargetEntries = targetEntries.filter(
    (targetEntry) =>
      entryWorkspaceId(targetEntry) === targetWorkspaceId &&
      entryProjectId(targetEntry) !== null &&
      isCompletedEntry(targetEntry),
  );

  const candidateTargetIndexes = sourceEntries.map((sourceEntry) => {
    const mapping = config.projectMappings[sourceProjectKey(sourceEntry)];
    if (!mapping) {
      throw new Error(`Missing project mapping for ${sourceProjectKey(sourceEntry)}.`);
    }
    return availableTargetEntries
      .map((targetEntry, index) => ({
        index,
        distance: duplicateDistance(sourceEntry, targetEntry, mapping.toProjectId),
      }))
      .filter((candidate): candidate is { index: number; distance: number } =>
        candidate.distance !== null,
      )
      .sort((left, right) => left.distance - right.distance)
      .map(({ index }) => index);
  });

  const matchedSourceByTarget = new Map<number, number>();
  const tryMatch = (sourceIndex: number, seenTargetIndexes: Set<number>): boolean => {
    for (const targetIndex of candidateTargetIndexes[sourceIndex] ?? []) {
      if (seenTargetIndexes.has(targetIndex)) continue;
      seenTargetIndexes.add(targetIndex);
      const previouslyMatchedSource = matchedSourceByTarget.get(targetIndex);
      if (
        previouslyMatchedSource === undefined ||
        tryMatch(previouslyMatchedSource, seenTargetIndexes)
      ) {
        matchedSourceByTarget.set(targetIndex, sourceIndex);
        return true;
      }
    }
    return false;
  };

  const matchedSourceIndexes = new Set<number>();
  for (const sourceIndex of sourceEntries.keys()) {
    if (tryMatch(sourceIndex, new Set())) matchedSourceIndexes.add(sourceIndex);
  }

  return {
    entries: sourceEntries.filter((_, index) => !matchedSourceIndexes.has(index)),
    alreadyPresentInTargetSkipped: matchedSourceIndexes.size,
  };
}

export function buildCreateTimeEntryInput(
  sourceEntry: TogglTimeEntry,
  targetWorkspaceId: number,
  targetProjectId: number,
): CreateTimeEntryInput {
  const stop = new Date(Date.parse(sourceEntry.start) + sourceEntry.duration * 1000).toISOString();
  return {
    workspace_id: targetWorkspaceId,
    project_id: targetProjectId,
    description: sourceEntry.description ?? "",
    start: sourceEntry.start,
    stop,
    duration: sourceEntry.duration,
    tags: [...new Set([...(sourceEntry.tags ?? []), SYNC_TAG])],
    billable: sourceEntry.billable ?? false,
    created_with: "toggl-sync",
  };
}

export function computeSummary(
  entries: TogglTimeEntry[],
  config: SyncConfig,
  runningEntriesSkipped: number,
  alreadyCopiedSkipped: number,
  alreadyPresentInTargetSkipped: number,
): SyncSummary {
  if (entries.length === 0) {
    throw new Error("Cannot summarize an empty set of entries.");
  }
  const starts = entries.map((entry) => entry.start).sort();
  const targetProjectIds = new Set(
    entries.map((entry) => {
      const mapping = config.projectMappings[sourceProjectKey(entry)];
      if (!mapping) throw new Error(`Missing project mapping for ${sourceProjectKey(entry)}.`);
      return mapping.toProjectId;
    }),
  );

  return {
    entryCount: entries.length,
    sourceProjectCount: new Set(entries.map(sourceProjectKey)).size,
    targetProjectCount: targetProjectIds.size,
    durationSeconds: entries.reduce((total, entry) => total + entry.duration, 0),
    earliestStart: starts[0]!,
    latestStart: starts.at(-1)!,
    runningEntriesSkipped,
    alreadyCopiedSkipped,
    alreadyPresentInTargetSkipped,
  };
}

export function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
}

export function formatMigrationEntryLine(
  entry: TogglTimeEntry,
  targetProjectName: string,
): string {
  const description = (entry.description ?? "").replace(/\s+/g, " ").trim() || "(no description)";
  return `${entry.start} - ${formatDuration(entry.duration)} - ${targetProjectName} - ${description}`;
}

export function initialStartDate(now: Date): string {
  return new Date(now.getTime() - INITIAL_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
}
