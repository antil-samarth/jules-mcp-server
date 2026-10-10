/**
 * Typed client for the Google Jules REST API (v1alpha).
 * https://developers.google.com/jules/api/reference/rest
 *
 * This module is framework-free: it only depends on the global `fetch`, so it can be
 * unit-tested with a mocked `fetch` and reused outside of Next.js.
 */

export const JULES_BASE_URL = "https://jules.googleapis.com/v1alpha";
const REQUEST_TIMEOUT_MS = 25_000;
const MAX_ERROR_MESSAGE_LENGTH = 500;

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

/** Thrown when the server is missing required configuration (e.g. JULES_API_KEY). */
export class JulesConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JulesConfigError";
  }
}

/** Thrown for caller mistakes detected before any network call (bad ids, etc.). */
export class JulesValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JulesValidationError";
  }
}

/** Thrown when the Jules API responds with a non-2xx status or cannot be reached. */
export class JulesApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "JulesApiError";
    this.status = status;
  }
}

/* ------------------------------------------------------------------ */
/* Types (the API is alpha, so unknown fields are tolerated)           */
/* ------------------------------------------------------------------ */

export interface GitHubBranch {
  displayName: string;
}

export interface GitHubRepo {
  owner: string;
  repo: string;
  isPrivate?: boolean;
  defaultBranch?: GitHubBranch;
  branches?: GitHubBranch[];
}

export interface JulesSource {
  /** Resource name, e.g. `sources/github/octocat/hello-world`. */
  name: string;
  id?: string;
  githubRepo?: GitHubRepo;
}

export interface ListSourcesResponse {
  sources?: JulesSource[];
  nextPageToken?: string;
}

export type AutomationMode = "AUTOMATION_MODE_UNSPECIFIED" | "AUTO_CREATE_PR";

export interface PullRequestOutput {
  url: string;
  title?: string;
  description?: string;
}

export interface SessionOutput {
  pullRequest?: PullRequestOutput;
}

export interface JulesSession {
  /** Resource name, e.g. `sessions/1234567`. */
  name: string;
  id?: string;
  title?: string;
  prompt?: string;
  state?: string;
  url?: string;
  createTime?: string;
  updateTime?: string;
  requirePlanApproval?: boolean;
  automationMode?: AutomationMode;
  sourceContext?: {
    source: string;
    githubRepoContext?: { startingBranch?: string };
  };
  outputs?: SessionOutput[];
}

export interface JulesActivity {
  name: string;
  id?: string;
  createTime?: string;
  originator?: string;
  description?: string;
  /** Union of activity payloads (planGenerated, progressUpdated, ...). Kept open on purpose. */
  [key: string]: unknown;
}

export interface ListActivitiesResponse {
  activities?: JulesActivity[];
  nextPageToken?: string;
}

/* ------------------------------------------------------------------ */
/* Input validation (guards against path/query injection)              */
/* ------------------------------------------------------------------ */

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SOURCE_NAME_PATTERN = /^sources\/github\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Accepts `1234` or `sessions/1234` and returns the canonical `sessions/1234`. */
export function normalizeSessionId(input: string): string {
  const trimmed = input.trim();
  const id = trimmed.startsWith("sessions/") ? trimmed.slice("sessions/".length) : trimmed;
  if (!SESSION_ID_PATTERN.test(id)) {
    throw new JulesValidationError(
      "Invalid sessionId. Expected an id like `1234567` or `sessions/1234567`.",
    );
  }
  return `sessions/${id}`;
}

/**
 * Accepts `sources/github/owner/repo` or the shorthand `owner/repo` and returns
 * the canonical `sources/github/owner/repo`.
 */
export function normalizeSourceName(input: string): string {
  const trimmed = input.trim();
  const name = trimmed.startsWith("sources/") ? trimmed : `sources/github/${trimmed}`;
  if (!SOURCE_NAME_PATTERN.test(name)) {
    throw new JulesValidationError(
      "Invalid source. Expected `sources/github/<owner>/<repo>` (or `<owner>/<repo>`).",
    );
  }
  return name;
}

/* ------------------------------------------------------------------ */
/* Core request helper                                                 */
/* ------------------------------------------------------------------ */

function getApiKey(): string {
  const key = process.env.JULES_API_KEY;
  if (!key || key.trim() === "") {
    throw new JulesConfigError("JULES_API_KEY is not configured on the server.");
  }
  return key.trim();
}

function truncate(text: string): string {
  return text.length > MAX_ERROR_MESSAGE_LENGTH ? `${text.slice(0, MAX_ERROR_MESSAGE_LENGTH)}…` : text;
}

function describeStatus(status: number): string {
  switch (status) {
    case 400:
      return "Jules rejected the request as invalid";
    case 401:
      return "Jules rejected the API key (check JULES_API_KEY)";
    case 403:
      return "Jules denied access (key lacks permission or the repo is not connected)";
    case 404:
      return "Jules resource not found";
    case 429:
      return "Jules rate limit / quota exceeded";
    default:
      return status >= 500 ? "Jules service error" : "Jules request failed";
  }
}

async function extractUpstreamMessage(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null && "error" in body) {
      const error = (body as { error?: { message?: unknown } }).error;
      if (typeof error?.message === "string") return error.message;
    }
  } catch {
    // Non-JSON error body; fall back to the generic status description.
  }
  return undefined;
}

interface RequestOptions {
  method?: "GET" | "POST";
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}

async function julesFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const apiKey = getApiKey();

  const url = new URL(`${JULES_BASE_URL}/${path}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method ?? "GET",
      headers: {
        "x-goog-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new JulesApiError(timedOut ? 504 : 502, timedOut ? "Jules request timed out" : "Could not reach the Jules API");
  }

  if (!response.ok) {
    const upstream = await extractUpstreamMessage(response);
    const base = describeStatus(response.status);
    throw new JulesApiError(response.status, truncate(upstream ? `${base}: ${upstream}` : base));
  }

  // Some endpoints (sendMessage, approvePlan) return an empty body.
  const text = await response.text();
  if (text.trim() === "") return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new JulesApiError(502, "Jules returned a non-JSON response");
  }
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export interface ListSourcesParams {
  pageSize?: number;
  pageToken?: string | undefined;
}

/** `GET /sources` */
export function listSources(params: ListSourcesParams = {}): Promise<ListSourcesResponse> {
  return julesFetch<ListSourcesResponse>("sources", {
    query: { pageSize: params.pageSize, pageToken: params.pageToken },
  });
}

export interface CreateSessionParams {
  prompt: string;
  /** `sources/github/owner/repo` or `owner/repo`. */
  source: string;
  /** Branch Jules starts from. */
  branch: string;
  title?: string | undefined;
  automationMode?: AutomationMode | undefined;
  requirePlanApproval?: boolean | undefined;
}

/** `POST /sessions` */
export function createSession(params: CreateSessionParams): Promise<JulesSession> {
  const body: Record<string, unknown> = {
    prompt: params.prompt,
    sourceContext: {
      source: normalizeSourceName(params.source),
      githubRepoContext: { startingBranch: params.branch },
    },
  };
  if (params.title) body.title = params.title;
  if (params.automationMode && params.automationMode !== "AUTOMATION_MODE_UNSPECIFIED") {
    body.automationMode = params.automationMode;
  }
  if (params.requirePlanApproval !== undefined) body.requirePlanApproval = params.requirePlanApproval;

  return julesFetch<JulesSession>("sessions", { method: "POST", body });
}

/** `GET /sessions/{id}` — session state and outputs (e.g. pull request URL). */
export function getSession(sessionId: string): Promise<JulesSession> {
  return julesFetch<JulesSession>(normalizeSessionId(sessionId));
}

export interface ListActivitiesParams {
  sessionId: string;
  pageSize?: number;
  pageToken?: string | undefined;
}

/** `GET /sessions/{id}/activities` */
export function listActivities(params: ListActivitiesParams): Promise<ListActivitiesResponse> {
  return julesFetch<ListActivitiesResponse>(`${normalizeSessionId(params.sessionId)}/activities`, {
    query: { pageSize: params.pageSize, pageToken: params.pageToken },
  });
}

export interface SendMessageParams {
  sessionId: string;
  prompt: string;
}

/** `POST /sessions/{id}:sendMessage` */
export async function sendMessage(params: SendMessageParams): Promise<{ sent: true; session: string }> {
  const session = normalizeSessionId(params.sessionId);
  await julesFetch<Record<string, never>>(`${session}:sendMessage`, {
    method: "POST",
    body: { prompt: params.prompt },
  });
  return { sent: true, session };
}

/** `POST /sessions/{id}:approvePlan` — needed for sessions created with `requirePlanApproval`. */
export async function approvePlan(sessionId: string): Promise<{ approved: true; session: string }> {
  const session = normalizeSessionId(sessionId);
  await julesFetch<Record<string, never>>(`${session}:approvePlan`, { method: "POST", body: {} });
  return { approved: true, session };
}
