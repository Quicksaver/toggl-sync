import type {
  CreateTimeEntryInput,
  TogglProject,
  TogglTimeEntry,
  TogglWorkspace,
} from "./types.js";

const DEFAULT_API_ROOT = "https://api.track.toggl.com/api/v9";

type FetchImplementation = typeof fetch;
type SleepImplementation = (milliseconds: number) => Promise<void>;
type QuotaWaitReporter = (accountLabel: string, seconds: number) => void;

const defaultSleep: SleepImplementation = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const defaultQuotaWaitReporter: QuotaWaitReporter = (accountLabel, seconds) => {
  const minutes = Math.ceil(seconds / 60);
  console.log(
    `${accountLabel} API quota is exhausted; waiting about ${minutes} minute${minutes === 1 ? "" : "s"} before resuming…`,
  );
};

function unwrapList<T>(value: unknown, label: string): T[] {
  if (Array.isArray(value)) return value as T[];
  if (
    typeof value === "object" &&
    value !== null &&
    "items" in value &&
    Array.isArray((value as { items: unknown }).items)
  ) {
    return (value as { items: T[] }).items;
  }
  throw new Error(`Toggl returned an unexpected ${label} response.`);
}

export class TogglApiError extends Error {
  constructor(
    readonly accountLabel: string,
    readonly status: number,
    readonly responseBody: string,
  ) {
    super(
      `${accountLabel} Toggl request failed (${status}): ${responseBody.slice(0, 500) || "empty response"}`,
    );
  }
}

export class TogglClient {
  readonly #authorization: string;
  #quotaBlockedUntil = 0;

  constructor(
    apiToken: string,
    readonly accountLabel: string,
    readonly apiRoot = DEFAULT_API_ROOT,
    readonly fetchImplementation: FetchImplementation = fetch,
    readonly sleepImplementation: SleepImplementation = defaultSleep,
    readonly quotaWaitReporter: QuotaWaitReporter = defaultQuotaWaitReporter,
  ) {
    this.#authorization = `Basic ${Buffer.from(`${apiToken}:api_token`).toString("base64")}`;
  }

  async #waitForKnownQuotaReset(): Promise<void> {
    const remainingMilliseconds = this.#quotaBlockedUntil - Date.now();
    if (remainingMilliseconds <= 0) return;
    this.#quotaBlockedUntil = 0;
    const waitMilliseconds = remainingMilliseconds + 1_000;
    this.quotaWaitReporter(this.accountLabel, Math.ceil(waitMilliseconds / 1_000));
    await this.sleepImplementation(waitMilliseconds);
  }

  #recordQuotaHeaders(response: Response): void {
    const remaining = Number(response.headers.get("x-toggl-quota-remaining"));
    const resetSeconds = Number(response.headers.get("x-toggl-quota-resets-in"));
    if (remaining === 0 && Number.isFinite(resetSeconds) && resetSeconds > 0) {
      this.#quotaBlockedUntil = Date.now() + resetSeconds * 1_000;
    }
  }

  async #request<T>(pathname: string, init?: RequestInit): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      await this.#waitForKnownQuotaReset();
      const response = await this.fetchImplementation(`${this.apiRoot}${pathname}`, {
        ...init,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: this.#authorization,
          ...init?.headers,
        },
      });

      this.#recordQuotaHeaders(response);
      const body = await response.text();
      if (response.ok) {
        if (body.length === 0) return undefined as T;
        return JSON.parse(body) as T;
      }

      const resetSeconds = Number(
        response.headers.get("x-toggl-quota-resets-in") ?? response.headers.get("retry-after"),
      );
      const isQuotaResponse = response.status === 429 || response.status === 402;
      if (isQuotaResponse && Number.isFinite(resetSeconds) && resetSeconds > 0 && attempt < 3) {
        const waitMilliseconds = resetSeconds * 1_000 + 1_000;
        this.#quotaBlockedUntil = 0;
        this.quotaWaitReporter(this.accountLabel, Math.ceil(waitMilliseconds / 1_000));
        await this.sleepImplementation(waitMilliseconds);
        continue;
      }

      throw new TogglApiError(this.accountLabel, response.status, body);
    }
  }

  async getWorkspaces(): Promise<TogglWorkspace[]> {
    return unwrapList<TogglWorkspace>(await this.#request<unknown>("/workspaces"), "workspaces");
  }

  async getProjects(workspaceId: number): Promise<TogglProject[]> {
    const query = new URLSearchParams({ active: "both" });
    return unwrapList<TogglProject>(
      await this.#request<unknown>(`/workspaces/${workspaceId}/projects?${query}`),
      "projects",
    );
  }

  async getTimeEntries(startDate: string, endDate: string): Promise<TogglTimeEntry[]> {
    const query = new URLSearchParams({ start_date: startDate, end_date: endDate, meta: "true" });
    return unwrapList<TogglTimeEntry>(
      await this.#request<unknown>(`/me/time_entries?${query}`),
      "time entries",
    );
  }

  async getTimeEntry(timeEntryId: number): Promise<TogglTimeEntry> {
    return this.#request<TogglTimeEntry>(`/me/time_entries/${timeEntryId}?meta=true`);
  }

  async createTimeEntry(
    workspaceId: number,
    input: CreateTimeEntryInput,
  ): Promise<TogglTimeEntry> {
    return this.#request<TogglTimeEntry>(`/workspaces/${workspaceId}/time_entries`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
}
