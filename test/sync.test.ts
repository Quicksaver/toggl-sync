import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  NO_PROJECT_KEY,
  SYNC_TAG,
  assertDistinctWorkspaces,
  buildCreateTimeEntryInput,
  computeSummary,
  filterEntriesAlreadyInTarget,
  fingerprintTimeEntry,
  formatMigrationEntryLine,
  gatherSourceProjectRequirements,
  latestCopiedEntry,
  missingProjectMappings,
  selectEntriesToCopy,
  sourceProjectKey,
  verifyLatestCopiedTarget,
} from "../src/sync.js";
import type { CopiedEntryRecord, SyncConfig, TogglTimeEntry } from "../src/types.js";

function entry(overrides: Partial<TogglTimeEntry> = {}): TogglTimeEntry {
  return {
    id: 1,
    workspace_id: 10,
    project_id: 20,
    project_name: "Source project",
    description: "Work",
    start: "2026-08-01T10:00:00Z",
    stop: "2026-08-01T11:00:01Z",
    duration: 3_601,
    tags: ["client"],
    billable: true,
    ...overrides,
  };
}

function config(): SyncConfig {
  return {
    version: 1,
    from: { apiToken: "from", workspaceId: 10 },
    to: { apiToken: "to", workspaceId: 11 },
    projectMappings: {},
    copiedEntries: [],
  };
}

describe("project mapping", () => {
  it("allows one account to sync between different workspaces", () => {
    assert.doesNotThrow(() => assertDistinctWorkspaces(10, 11));
    assert.throws(() => assertDistinctWorkspaces(10, 10), /must be different workspaces/);
  });

  it("requires a mapping for every represented source project, including no project", () => {
    const entries = [entry(), entry({ id: 2, project_id: null, project_name: null })];
    const requirements = gatherSourceProjectRequirements(entries, []);

    assert.deepEqual(
      requirements.map(({ key, entryCount }) => ({ key, entryCount })),
      [
        { key: NO_PROJECT_KEY, entryCount: 1 },
        { key: "project:20", entryCount: 1 },
      ],
    );
    assert.equal(missingProjectMappings(requirements, [{ id: 30, name: "Target" }], config()).length, 2);
  });

  it("invalidates a saved mapping when its target project is unavailable", () => {
    const syncConfig = config();
    syncConfig.projectMappings["project:20"] = {
      fromProjectName: "Source project",
      toProjectId: 99,
      toProjectName: "Archived",
    };
    const requirements = gatherSourceProjectRequirements([entry()], []);

    assert.equal(missingProjectMappings(requirements, [{ id: 30, name: "Target" }], syncConfig).length, 1);
  });
});

describe("entry selection and cursor provenance", () => {
  it("filters other workspaces, running entries, and already copied entries", () => {
    const copied: CopiedEntryRecord = {
      sourceEntryId: 1,
      targetEntryId: 101,
      sourceStart: "2026-08-01T10:00:00Z",
      sourceProjectKey: "project:20",
      targetProjectId: 30,
      fingerprint: "hash",
      copiedAt: "2026-08-01T12:00:00Z",
    };
    const result = selectEntriesToCopy(
      [
        entry(),
        entry({ id: 2, stop: null, duration: -1 }),
        entry({ id: 3, workspace_id: 999 }),
        entry({ id: 4, start: "2026-08-02T10:00:00Z" }),
      ],
      10,
      [copied],
    );

    assert.deepEqual(result.entries.map(({ id }) => id), [4]);
    assert.equal(result.runningEntriesSkipped, 1);
    assert.equal(result.alreadyCopiedSkipped, 1);
  });

  it("filters mapped entries already present in the target using multiset counts", () => {
    const syncConfig = config();
    syncConfig.projectMappings["project:20"] = {
      fromProjectName: "Source project",
      toProjectId: 30,
      toProjectName: "Target",
    };
    const firstSource = entry();
    const secondIdenticalSource = entry({ id: 2 });
    const differentSource = entry({ id: 3, description: "Different work" });
    const result = filterEntriesAlreadyInTarget(
      [firstSource, secondIdenticalSource, differentSource],
      [
        entry({
          id: 101,
          workspace_id: 11,
          project_id: 30,
          start: "2026-08-01T10:00:02+00:00",
          duration: 3_599,
        }),
      ],
      11,
      syncConfig,
    );

    assert.equal(result.alreadyPresentInTargetSkipped, 1);
    assert.deepEqual(result.entries.map(({ id }) => id), [2, 3]);
  });

  it("does not filter temporal differences outside the duplicate tolerance", () => {
    const syncConfig = config();
    syncConfig.projectMappings["project:20"] = {
      fromProjectName: "Source project",
      toProjectId: 30,
      toProjectName: "Target",
    };
    const result = filterEntriesAlreadyInTarget(
      [entry(), entry({ id: 2, start: "2026-08-02T10:00:00Z" })],
      [
        entry({
          id: 101,
          workspace_id: 11,
          project_id: 30,
          start: "2026-08-01T10:00:04Z",
        }),
        entry({
          id: 102,
          workspace_id: 11,
          project_id: 30,
          start: "2026-08-02T10:00:00Z",
          duration: 3_597,
        }),
      ],
      11,
      syncConfig,
    );

    assert.equal(result.alreadyPresentInTargetSkipped, 0);
    assert.deepEqual(result.entries.map(({ id }) => id), [1, 2]);
  });

  it("reassigns a close match when necessary to avoid duplicating another source entry", () => {
    const syncConfig = config();
    syncConfig.projectMappings["project:20"] = {
      fromProjectName: "Source project",
      toProjectId: 30,
      toProjectName: "Target",
    };
    const result = filterEntriesAlreadyInTarget(
      [
        entry({ id: 1, start: "2026-08-01T10:00:00Z" }),
        entry({ id: 2, start: "2026-08-01T09:59:57Z" }),
      ],
      [
        entry({ id: 101, workspace_id: 11, project_id: 30, start: "2026-08-01T10:00:00Z" }),
        entry({ id: 102, workspace_id: 11, project_id: 30, start: "2026-08-01T10:00:03Z" }),
      ],
      11,
      syncConfig,
    );

    assert.equal(result.alreadyPresentInTargetSkipped, 2);
    assert.deepEqual(result.entries, []);
  });

  it("does not filter target entries from another workspace or mapped project", () => {
    const syncConfig = config();
    syncConfig.projectMappings["project:20"] = {
      fromProjectName: "Source project",
      toProjectId: 30,
      toProjectName: "Target",
    };
    const result = filterEntriesAlreadyInTarget(
      [entry()],
      [
        entry({ id: 101, workspace_id: 999, project_id: 30 }),
        entry({ id: 102, workspace_id: 11, project_id: 31 }),
      ],
      11,
      syncConfig,
    );

    assert.equal(result.alreadyPresentInTargetSkipped, 0);
    assert.deepEqual(result.entries.map(({ id }) => id), [1]);
  });

  it("chooses the newest copied source timestamp", () => {
    const records: CopiedEntryRecord[] = [
      {
        sourceEntryId: 1,
        targetEntryId: 101,
        sourceStart: "2026-08-01T10:00:00Z",
        sourceProjectKey: "project:20",
        targetProjectId: 30,
        fingerprint: "one",
        copiedAt: "2026-08-02T10:00:00Z",
      },
      {
        sourceEntryId: 2,
        targetEntryId: 102,
        sourceStart: "2026-08-03T10:00:00Z",
        sourceProjectKey: "project:20",
        targetProjectId: 30,
        fingerprint: "two",
        copiedAt: "2026-08-03T11:00:00Z",
      },
    ];

    assert.equal(latestCopiedEntry(records)?.targetEntryId, 102);
  });

  it("rejects a manual or modified target entry", () => {
    const target = entry({ id: 101, workspace_id: 11, project_id: 30, tags: [SYNC_TAG] });
    const record: CopiedEntryRecord = {
      sourceEntryId: 1,
      targetEntryId: 101,
      sourceStart: target.start,
      sourceProjectKey: "project:20",
      targetProjectId: 30,
      fingerprint: fingerprintTimeEntry(target),
      copiedAt: "2026-08-01T12:00:00Z",
    };

    assert.doesNotThrow(() => verifyLatestCopiedTarget(record, target, 11));
    assert.throws(
      () => verifyLatestCopiedTarget(record, { ...target, description: "Manual edit" }, 11),
      /fingerprint/,
    );
    assert.throws(
      () => verifyLatestCopiedTarget(record, { ...target, tags: [] }, 11),
      /reserved toggl-sync tag/,
    );
  });
});

describe("copy payload and summary", () => {
  it("formats each migration entry on exactly one line", () => {
    assert.equal(
      formatMigrationEntryLine(
        entry({ description: "First line\nsecond   line", duration: 3_661 }),
        "Target project",
      ),
      "2026-08-01T10:00:00Z - 1h 01m 01s - Target project - First line second line",
    );
    assert.equal(
      formatMigrationEntryLine(entry({ description: null }), "Target project"),
      "2026-08-01T10:00:00Z - 1h 00m 01s - Target project - (no description)",
    );
  });

  it("preserves seconds and adds the provenance tag", () => {
    const input = buildCreateTimeEntryInput(entry(), 11, 30);

    assert.equal(input.duration, 3_601);
    assert.equal(input.start, "2026-08-01T10:00:00Z");
    assert.equal(input.stop, "2026-08-01T11:00:01.000Z");
    assert.deepEqual(input.tags, ["client", SYNC_TAG]);
    assert.equal(input.project_id, 30);
    assert.equal(input.workspace_id, 11);
  });

  it("summarizes entries only after all mappings exist", () => {
    const syncConfig = config();
    syncConfig.projectMappings[sourceProjectKey(entry())] = {
      fromProjectName: "Source project",
      toProjectId: 30,
      toProjectName: "Target",
    };
    const summary = computeSummary([entry(), entry({ id: 2 })], syncConfig, 1, 3, 4);

    assert.equal(summary.entryCount, 2);
    assert.equal(summary.sourceProjectCount, 1);
    assert.equal(summary.targetProjectCount, 1);
    assert.equal(summary.durationSeconds, 7_202);
    assert.equal(summary.runningEntriesSkipped, 1);
    assert.equal(summary.alreadyCopiedSkipped, 3);
    assert.equal(summary.alreadyPresentInTargetSkipped, 4);
  });
});
