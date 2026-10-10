import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { withBearerAuth, safeEqual, extractBearerToken, corsHeadersFor } from "@/lib/auth";

describe("auth middleware", () => {
  const originalEnv = process.env;
  const VALID_TOKEN = "a-very-long-secret-token-32-chars-at-least";

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("safeEqual", () => {
    it("returns true for identical strings", () => {
      expect(safeEqual("hello", "hello")).toBe(true);
    });

    it("returns false for different strings", () => {
      expect(safeEqual("hello", "world")).toBe(false);
      expect(safeEqual("hello", "hello ")).toBe(false);
    });
  });

  describe("extractBearerToken", () => {
    it("extracts valid Bearer token", () => {
      const req = new Request("http://localhost/api/mcp", {
        headers: { Authorization: "Bearer test-token-123" },
      });
      expect(extractBearerToken(req)).toBe("test-token-123");
    });

    it("handles case-insensitive scheme", () => {
      const req = new Request("http://localhost/api/mcp", {
        headers: { Authorization: "bearer test-token-123" },
      });
      expect(extractBearerToken(req)).toBe("test-token-123");
    });

    it("returns undefined for missing header", () => {
      const req = new Request("http://localhost/api/mcp");
      expect(extractBearerToken(req)).toBeUndefined();
    });

    it("returns undefined for non-Bearer scheme", () => {
      const req = new Request("http://localhost/api/mcp", {
        headers: { Authorization: "Basic dXNlcjpwYXNz" },
      });
      expect(extractBearerToken(req)).toBeUndefined();
    });
  });

  describe("corsHeadersFor", () => {
    it("returns empty object when MCP_CORS_ORIGINS is not set", () => {
      delete process.env.MCP_CORS_ORIGINS;
      const req = new Request("http://localhost/api/mcp", {
        headers: { Origin: "http://example.com" },
      });
      expect(corsHeadersFor(req)).toEqual({});
    });

    it("returns allow origin when origin is in allowlist", () => {
      process.env.MCP_CORS_ORIGINS = "http://example.com,http://localhost:3000";
      const req = new Request("http://localhost/api/mcp", {
        headers: { Origin: "http://example.com" },
      });
      const cors = corsHeadersFor(req);
      expect(cors["Access-Control-Allow-Origin"]).toBe("http://example.com");
      expect(cors.Vary).toBe("Origin");
    });

    it("supports wildcard origin", () => {
      process.env.MCP_CORS_ORIGINS = "*";
      const req = new Request("http://localhost/api/mcp", {
        headers: { Origin: "http://unknown.com" },
      });
      const cors = corsHeadersFor(req);
      expect(cors["Access-Control-Allow-Origin"]).toBe("*");
    });
  });

  describe("withBearerAuth", () => {
    it("returns 500 fail-closed if MCP_AUTH_TOKEN is unset", async () => {
      delete process.env.MCP_AUTH_TOKEN;
      const inner = vi.fn(async () => new Response("ok"));
      const handler = withBearerAuth(inner);

      const req = new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
      });
      const res = await handler(req);

      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data).toEqual({ error: "server_misconfigured" });
      expect(inner).not.toHaveBeenCalled();
    });

    it("returns 500 fail-closed if MCP_AUTH_TOKEN is shorter than 16 chars", async () => {
      process.env.MCP_AUTH_TOKEN = "too-short";
      const inner = vi.fn(async () => new Response("ok"));
      const handler = withBearerAuth(inner);

      const req = new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: { Authorization: "Bearer too-short" },
      });
      const res = await handler(req);

      expect(res.status).toBe(500);
      expect(inner).not.toHaveBeenCalled();
    });

    it("returns 401 with WWW-Authenticate if Authorization header is missing", async () => {
      process.env.MCP_AUTH_TOKEN = VALID_TOKEN;
      const inner = vi.fn(async () => new Response("ok"));
      const handler = withBearerAuth(inner);

      const req = new Request("http://localhost/api/mcp", { method: "POST" });
      const res = await handler(req);

      expect(res.status).toBe(401);
      expect(res.headers.get("WWW-Authenticate")).toBe('Bearer realm="jules-mcp"');
      const data = await res.json();
      expect(data).toEqual({ error: "unauthorized" });
      expect(inner).not.toHaveBeenCalled();
    });

    it("returns 401 if token is incorrect", async () => {
      process.env.MCP_AUTH_TOKEN = VALID_TOKEN;
      const inner = vi.fn(async () => new Response("ok"));
      const handler = withBearerAuth(inner);

      const req = new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: { Authorization: "Bearer wrong-token-1234567890123456" },
      });
      const res = await handler(req);

      expect(res.status).toBe(401);
      expect(res.headers.get("WWW-Authenticate")).toBe('Bearer realm="jules-mcp"');
      expect(inner).not.toHaveBeenCalled();
    });

    it("invokes inner handler when token is valid", async () => {
      process.env.MCP_AUTH_TOKEN = VALID_TOKEN;
      const inner = vi.fn(async () => new Response(JSON.stringify({ result: "success" }), { status: 200 }));
      const handler = withBearerAuth(inner);

      const req = new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
      });
      const res = await handler(req);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ result: "success" });
      expect(inner).toHaveBeenCalledTimes(1);
    });

    it("handles OPTIONS preflight without requiring auth", async () => {
      process.env.MCP_AUTH_TOKEN = VALID_TOKEN;
      process.env.MCP_CORS_ORIGINS = "http://localhost:5173";
      const inner = vi.fn();
      const handler = withBearerAuth(inner);

      const req = new Request("http://localhost/api/mcp", {
        method: "OPTIONS",
        headers: { Origin: "http://localhost:5173" },
      });
      const res = await handler(req);

      expect(res.status).toBe(204);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");
      expect(inner).not.toHaveBeenCalled();
    });
  });
});
