export interface AccountConfig {
  apiToken: string;
  workspaceId: number | null;
}

export interface ProjectMapping {
  fromProjectName: string;
  toProjectId: number;
  toProjectName: string;
}

export interface CopiedEntryRecord {
  sourceEntryId: number;
  targetEntryId: number;
  sourceStart: string;
  sourceProjectKey: string;
  targetProjectId: number;
  fingerprint: string;
  copiedAt: string;
}

export interface SyncConfig {
  version: 1;
  from: AccountConfig;
  to: AccountConfig;
  projectMappings: Record<string, ProjectMapping>;
  copiedEntries: CopiedEntryRecord[];
}

export interface TogglWorkspace {
  id: number;
  name: string;
  organization_name?: string | null;
}

export interface TogglProject {
  id: number;
  name: string;
  active?: boolean;
  can_track_time?: boolean;
  client_name?: string | null;
  workspace_id?: number;
  wid?: number;
}

export interface TogglTimeEntry {
  id: number;
  workspace_id?: number;
  wid?: number;
  project_id?: number | null;
  pid?: number | null;
  project_name?: string | null;
  description?: string | null;
  start: string;
  stop?: string | null;
  duration: number;
  tags?: string[] | null;
  billable?: boolean;
  server_deleted_at?: string | null;
}

export interface CreateTimeEntryInput {
  workspace_id: number;
  project_id: number;
  description: string;
  start: string;
  stop: string;
  duration: number;
  tags: string[];
  billable: boolean;
  created_with: string;
}

export interface SourceProjectRequirement {
  key: string;
  id: number | null;
  name: string;
  entryCount: number;
}

export interface SyncSummary {
  entryCount: number;
  sourceProjectCount: number;
  targetProjectCount: number;
  durationSeconds: number;
  earliestStart: string;
  latestStart: string;
  runningEntriesSkipped: number;
  alreadyCopiedSkipped: number;
  alreadyPresentInTargetSkipped: number;
}
