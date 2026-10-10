import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  JULES_BASE_URL,
  JulesConfigError,
  JulesValidationError,
  JulesApiError,
  normalizeSessionId,
  normalizeSourceName,
  listSources,
  listSessions,
  createSession,
  getSession,
  listActivities,
  sendMessage,
  approvePlan,
} from "@/lib/jules";

describe("jules client", () => {
  const originalEnv = process.env;
  const FAKE_KEY = "test-jules-api-key-12345";

  beforeEach(() => {
    process.env = { ...originalEnv, JULES_API_KEY: FAKE_KEY };
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("normalizeSessionId", () => {
    it("normalizes bare numeric or alphanumeric ids", () => {
      expect(normalizeSessionId("123456")).toBe("sessions/123456");
      expect(normalizeSessionId("abc-123_xyz")).toBe("sessions/abc-123_xyz");
    });

    it("normalizes sessions/ prefixed ids", () => {
      expect(normalizeSessionId("sessions/123456")).toBe("sessions/123456");
      expect(normalizeSessionId("  sessions/abc-123  ")).toBe("sessions/abc-123");
    });

    it("throws JulesValidationError on path traversal or invalid characters", () => {
      expect(() => normalizeSessionId("../sessions/123")).toThrow(JulesValidationError);
      expect(() => normalizeSessionId("123/evil")).toThrow(JulesValidationError);
      expect(() => normalizeSessionId("")).toThrow(JulesValidationError);
      expect(() => normalizeSessionId(" ")).toThrow(JulesValidationError);
      expect(() => normalizeSessionId("123?bad=1")).toThrow(JulesValidationError);
    });
  });

  describe("normalizeSourceName", () => {
    it("accepts full source resource names", () => {
      expect(normalizeSourceName("sources/github/owner/repo")).toBe("sources/github/owner/repo");
      expect(normalizeSourceName("  sources/github/owner-name/repo.js  ")).toBe("sources/github/owner-name/repo.js");
    });

    it("accepts shorthand owner/repo", () => {
      expect(normalizeSourceName("octocat/hello-world")).toBe("sources/github/octocat/hello-world");
    });

    it("throws JulesValidationError for invalid source formats", () => {
      expect(() => normalizeSourceName("invalid")).toThrow(JulesValidationError);
      expect(() => normalizeSourceName("sources/gitlab/owner/repo")).toThrow(JulesValidationError);
      expect(() => normalizeSourceName("../owner/repo")).toThrow(JulesValidationError);
    });
  });

  describe("API methods and request formation", () => {
    it("throws JulesConfigError if JULES_API_KEY is missing", async () => {
      delete process.env.JULES_API_KEY;
      await expect(listSources()).rejects.toThrow(JulesConfigError);
    });

    it("sends x-goog-api-key header and parses JSON response", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ sources: [{ name: "sources/github/foo/bar" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      global.fetch = mockFetch;

      const result = await listSources({ pageSize: 10, pageToken: "token1" });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0] as [URL, RequestInit];
      expect(url.toString()).toBe(`${JULES_BASE_URL}/sources?pageSize=10&pageToken=token1`);
      expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe(FAKE_KEY);
      expect(result).toEqual({ sources: [{ name: "sources/github/foo/bar" }] });
    });

    it("listSessions sends x-goog-api-key header and query params", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            sessions: [{ name: "sessions/s1", id: "s1", title: "Test session" }],
            nextPageToken: "next-token-123",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );
      global.fetch = mockFetch;

      const result = await listSessions({ pageSize: 25, pageToken: "token-abc" });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0] as [URL, RequestInit];
      expect(url.toString()).toBe(`${JULES_BASE_URL}/sessions?pageSize=25&pageToken=token-abc`);
      expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe(FAKE_KEY);
      expect(result).toEqual({
        sessions: [{ name: "sessions/s1", id: "s1", title: "Test session" }],
        nextPageToken: "next-token-123",
      });
    });

    it("listSessions works without parameters", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ sessions: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      global.fetch = mockFetch;

      const result = await listSessions();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url] = mockFetch.mock.calls[0] as [URL, RequestInit];
      expect(url.toString()).toBe(`${JULES_BASE_URL}/sessions`);
      expect(result).toEqual({ sessions: [] });
    });

    it("createSession formats body with sourceContext and githubRepoContext", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ name: "sessions/s1", id: "s1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      global.fetch = mockFetch;

      const result = await createSession({
        prompt: "Fix the bug",
        source: "owner/repo",
        branch: "develop",
        title: "Session Title",
        automationMode: "AUTO_CREATE_PR",
        requirePlanApproval: true,
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0] as [URL, RequestInit];
      expect(url.toString()).toBe(`${JULES_BASE_URL}/sessions`);
      expect(init.method).toBe("POST");
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({
        prompt: "Fix the bug",
        sourceContext: {
          source: "sources/github/owner/repo",
          githubRepoContext: { startingBranch: "develop" },
        },
        title: "Session Title",
        automationMode: "AUTO_CREATE_PR",
        requirePlanApproval: true,
      });
      expect(result).toEqual({ name: "sessions/s1", id: "s1" });
    });

    it("getSession fetches sessions/{id}", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ name: "sessions/123", state: "COMPLETED" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      global.fetch = mockFetch;

      const res = await getSession("123");
      expect(res.name).toBe("sessions/123");
      const [url] = mockFetch.mock.calls[0] as [URL, RequestInit];
      expect(url.toString()).toBe(`${JULES_BASE_URL}/sessions/123`);
    });

    it("listActivities fetches sessions/{id}/activities with query params", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ activities: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      global.fetch = mockFetch;

      await listActivities({ sessionId: "sessions/123", pageSize: 5 });
      const [url] = mockFetch.mock.calls[0] as [URL, RequestInit];
      expect(url.toString()).toBe(`${JULES_BASE_URL}/sessions/123/activities?pageSize=5`);
    });

    it("sendMessage tolerates empty body response", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response("", { status: 200 }),
      );
      global.fetch = mockFetch;

      const result = await sendMessage({ sessionId: "123", prompt: "Hello Jules" });
      expect(result).toEqual({ sent: true, session: "sessions/123" });
      const [url, init] = mockFetch.mock.calls[0] as [URL, RequestInit];
      expect(url.toString()).toBe(`${JULES_BASE_URL}/sessions/123:sendMessage`);
      expect(JSON.parse(init.body as string)).toEqual({ prompt: "Hello Jules" });
    });

    it("approvePlan sends POST with empty object and tolerates empty body response", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response("", { status: 200 }),
      );
      global.fetch = mockFetch;

      const result = await approvePlan("123");
      expect(result).toEqual({ approved: true, session: "sessions/123" });
      const [url, init] = mockFetch.mock.calls[0] as [URL, RequestInit];
      expect(url.toString()).toBe(`${JULES_BASE_URL}/sessions/123:approvePlan`);
      expect(JSON.parse(init.body as string)).toEqual({});
    });

    it("maps non-2xx status code to JulesApiError without leaking API key", async () => {
      const mockFetch = vi.fn().mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: { message: "Repository access denied" } }), {
            status: 403,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      );
      global.fetch = mockFetch;

      await expect(listSources()).rejects.toThrow(JulesApiError);
      try {
        await listSources();
      } catch (err) {
        expect(err).toBeInstanceOf(JulesApiError);
        const apiError = err as JulesApiError;
        expect(apiError.status).toBe(403);
        expect(apiError.message).toContain("Jules denied access");
        expect(apiError.message).toContain("Repository access denied");
        expect(apiError.message).not.toContain(FAKE_KEY);
      }
    });
  });
});
