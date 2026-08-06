# toggl-sync

One-way, review-before-write copying of completed Toggl Track entries between workspaces, whether they belong to one account or two.

## Setup

Requires Node.js 24 or newer. The active development version, 24.16.0, is pinned in `.nvmrc`.

```bash
yarn install
```

Open `toggl-sync.config.json` and replace both token placeholders. Each API token is available at the bottom of the corresponding Toggl Track Profile page. The config is gitignored and is written with owner-only permissions whenever the CLI updates it.

For two workspaces accessible through the same Toggl login, use the same API token in both fields. The CLI will select and save the FROM and TO workspaces independently. The exact same workspace cannot be used as both endpoints.

```json
{
  "from": { "apiToken": "...", "workspaceId": null },
  "to": { "apiToken": "...", "workspaceId": null }
}
```

Then run:

```bash
yarn start
```

If either account has multiple workspaces, the CLI asks which one to use and saves the choice.

## How syncing works

- The first run reads completed FROM ACCOUNT entries from the last 60 days.
- Every source project represented in those entries—including “No project”—must be mapped to an existing active TO ACCOUNT project using an arrow-key list.
- Mappings are saved immediately in `toggl-sync.config.json`.
- After mapping, the CLI fetches TO ACCOUNT entries in the gathered date range and removes matches with the same mapped project and description when start time is within 60 seconds and duration is within 3 seconds. The target search begins one minute before the earliest gathered source entry. Matching is count-aware and chooses the closest candidate, so one existing target entry filters only one source entry.
- The CLI prints a compact count/project/duration/date summary followed by every final entry as `Start Date & Time - Duration - Project - Description`, using the mapped TO project, and requires confirmation before creating anything.
- Copied entries preserve description, start, exact duration in seconds, billable status, and tags. Tasks are not copied because project mappings do not establish corresponding target tasks.
- Every copied entry receives the reserved `toggl-sync` tag. Its source ID, target ID, target fingerprint, and copy time are saved after each successful write.
- Later runs fetch the newest recorded TO entry by its exact ID and verify its workspace, reserved tag, and fingerprint. Only then is its source timestamp used as the next cursor.
- Fetching starts at the cursor timestamp and saved source IDs are removed, so multiple entries with the same start time cannot be skipped.
- Running entries are never copied; they are reported and can be picked up after they stop.
- Large imports automatically wait for Toggl's quota-reset headers and then resume. This matters on Free workspaces, whose current API allowance may require a long first import to span multiple quota windows.

If the latest copied TO entry was deleted or edited, the CLI stops rather than risk treating a manual entry as the sync cursor.

## Development

```bash
yarn verify
yarn build
```

Toggl stores API times in UTC. The CLI sends RFC 3339 timestamps and derives `stop` from `start + duration`, preserving the API's integer-second duration exactly.
