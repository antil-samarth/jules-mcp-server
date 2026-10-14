import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GET as getProtectedResource, OPTIONS as optionsProtectedResource } from "@/app/.well-known/oauth-protected-resource/route";
import { GET as getAuthServer, OPTIONS as optionsAuthServer } from "@/app/.well-known/oauth-authorization-server/route";
import { GET as getAuthorize } from "@/app/api/oauth/authorize/route";
import { POST as postToken, OPTIONS as optionsToken } from "@/app/api/oauth/token/route";
import {
  createAccessToken,
  createAuthCode,
  createRefreshToken,
  getBaseUrl,
  getOAuthSigningSecret,
  verifyAccessToken,
  verifyAuthCode,
  verifyPkce,
  verifyRefreshToken,
} from "@/lib/oauth";
import { createHash } from "node:crypto";

describe("OAuth 2.0 / RFC 9728 implementation", () => {
  const originalEnv = process.env;
  const CLIENT_ID = "test-client-id";
  const CLIENT_SECRET = "test-client-secret-1234567890123456";

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      MCP_CLIENT_ID: CLIENT_ID,
      MCP_CLIENT_SECRET: CLIENT_SECRET,
      MCP_AUTH_TOKEN: "static-token-at-least-32-chars-long",
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("Base URL resolution", () => {
    it("respects APP_URL if set", () => {
      process.env.APP_URL = "https://custom-mcp.example.com/";
      const req = new Request("http://localhost:3000/api/mcp");
      expect(getBaseUrl(req)).toBe("https://custom-mcp.example.com");
    });

    it("derives from host and proto headers", () => {
      delete process.env.APP_URL;
      const req = new Request("http://ignored/api/mcp", {
        headers: {
          host: "mcp.vercel.app",
          "x-forwarded-proto": "https",
        },
      });
      expect(getBaseUrl(req)).toBe("https://mcp.vercel.app");
    });

    it("keeps http for localhost", () => {
      delete process.env.APP_URL;
      const req = new Request("http://localhost:3000/api/mcp", {
        headers: {
          host: "localhost:3000",
        },
      });
      expect(getBaseUrl(req)).toBe("http://localhost:3000");
    });
  });

  describe("OAuth signing secret resolution", () => {
    it("throws error if neither MCP_CLIENT_SECRET nor MCP_AUTH_TOKEN is set", () => {
      delete process.env.MCP_CLIENT_SECRET;
      delete process.env.MCP_AUTH_TOKEN;
      expect(() => getOAuthSigningSecret()).toThrow("OAuth signing secret is not configured");
    });

    it("throws error if both secrets are shorter than 16 chars", () => {
      process.env.MCP_CLIENT_SECRET = "short";
      process.env.MCP_AUTH_TOKEN = "too-short";
      expect(() => getOAuthSigningSecret()).toThrow("OAuth signing secret is not configured");
    });

    it("returns MCP_CLIENT_SECRET when it has at least 16 chars", () => {
      process.env.MCP_CLIENT_SECRET = "secret-with-sixteen-chars";
      delete process.env.MCP_AUTH_TOKEN;
      expect(getOAuthSigningSecret()).toBe("secret-with-sixteen-chars");
    });

    it("falls back to MCP_AUTH_TOKEN when MCP_CLIENT_SECRET is unset or too short", () => {
      process.env.MCP_CLIENT_SECRET = "short";
      process.env.MCP_AUTH_TOKEN = "token-with-sixteen-chars";
      expect(getOAuthSigningSecret()).toBe("token-with-sixteen-chars");
    });
  });

  describe("Metadata endpoints", () => {
    it("returns RFC 9728 protected resource metadata", async () => {
      const req = new Request("https://mcp.example.com/.well-known/oauth-protected-resource", {
        headers: { host: "mcp.example.com", "x-forwarded-proto": "https" },
      });
      const res = getProtectedResource(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual({
        resource: "https://mcp.example.com/api/mcp",
        authorization_servers: ["https://mcp.example.com"],
        scopes_supported: ["mcp"],
      });
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    });

    it("handles OPTIONS on protected resource endpoint", () => {
      const res = optionsProtectedResource();
      expect(res.status).toBe(204);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    });

    it("returns RFC 8414 authorization server metadata", async () => {
      const req = new Request("https://mcp.example.com/.well-known/oauth-authorization-server", {
        headers: { host: "mcp.example.com", "x-forwarded-proto": "https" },
      });
      const res = getAuthServer(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.issuer).toBe("https://mcp.example.com");
      expect(data.authorization_endpoint).toBe("https://mcp.example.com/api/oauth/authorize");
      expect(data.token_endpoint).toBe("https://mcp.example.com/api/oauth/token");
      expect(data.response_types_supported).toEqual(["code"]);
      expect(data.grant_types_supported).toContain("authorization_code");
      expect(data.code_challenge_methods_supported).toContain("S256");
      expect(data.token_endpoint_auth_methods_supported).toContain("client_secret_basic");
      expect(data.token_endpoint_auth_methods_supported).toContain("client_secret_post");
    });

    it("handles OPTIONS on auth server endpoint", () => {
      const res = optionsAuthServer();
      expect(res.status).toBe(204);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    });
  });

  describe("OAuth Authorize endpoint", () => {
    it("fails closed with 500 when MCP_CLIENT_ID is unset", async () => {
      delete process.env.MCP_CLIENT_ID;
      const req = new Request(`https://mcp.example.com/api/oauth/authorize?client_id=${CLIENT_ID}&redirect_uri=https://gemini.google.com/oauth`);
      const res = getAuthorize(req);
      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toBe("server_misconfigured");
    });

    it("fails closed with 500 when MCP_CLIENT_SECRET is unset", async () => {
      delete process.env.MCP_CLIENT_SECRET;
      const req = new Request(`https://mcp.example.com/api/oauth/authorize?client_id=${CLIENT_ID}&redirect_uri=https://gemini.google.com/oauth`);
      const res = getAuthorize(req);
      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toBe("server_misconfigured");
    });

    it("fails closed with 500 when MCP_CLIENT_SECRET is shorter than 16 chars", async () => {
      process.env.MCP_CLIENT_SECRET = "short-secret";
      const req = new Request(`https://mcp.example.com/api/oauth/authorize?client_id=${CLIENT_ID}&redirect_uri=https://gemini.google.com/oauth`);
      const res = getAuthorize(req);
      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toBe("server_misconfigured");
    });

    it("rejects request missing client_id", async () => {
      const req = new Request("https://mcp.example.com/api/oauth/authorize?redirect_uri=https://gemini.google.com/oauth");
      const res = getAuthorize(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe("invalid_request");
    });

    it("rejects request with wrong client_id", async () => {
      const req = new Request("https://mcp.example.com/api/oauth/authorize?client_id=wrong&redirect_uri=https://gemini.google.com/oauth");
      const res = getAuthorize(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe("unauthorized_client");
    });

    it("rejects request missing redirect_uri", async () => {
      const req = new Request(`https://mcp.example.com/api/oauth/authorize?client_id=${CLIENT_ID}`);
      const res = getAuthorize(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe("invalid_request");
    });

    it("rejects malformed redirect_uri", async () => {
      const req = new Request(`https://mcp.example.com/api/oauth/authorize?client_id=${CLIENT_ID}&redirect_uri=javascript:alert(1)`);
      const res = getAuthorize(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe("invalid_request");
    });

    it("generates code and redirects 302 with PKCE challenge preserved", async () => {
      const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
      const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");

      const req = new Request(
        `https://mcp.example.com/api/oauth/authorize?client_id=${CLIENT_ID}&redirect_uri=https://gemini.google.com/oauth&state=xyz123&code_challenge=${challenge}&code_challenge_method=S256`,
      );
      const res = getAuthorize(req);
      expect(res.status).toBe(302);
      const location = res.headers.get("Location");
      expect(location).toBeTruthy();

      const redirectUrl = new URL(location!);
      expect(redirectUrl.origin + redirectUrl.pathname).toBe("https://gemini.google.com/oauth");
      expect(redirectUrl.searchParams.get("state")).toBe("xyz123");
      const code = redirectUrl.searchParams.get("code");
      expect(code).toBeTruthy();

      const verified = verifyAuthCode(code!);
      expect(verified).not.toBeNull();
      expect(verified?.clientId).toBe(CLIENT_ID);
      expect(verified?.codeChallenge).toBe(challenge);
      expect(verified?.codeChallengeMethod).toBe("S256");
    });
  });

  describe("OAuth Token endpoint", () => {
    it("fails closed with 500 when MCP_CLIENT_ID is unset", async () => {
      delete process.env.MCP_CLIENT_ID;
      const req = new Request("https://mcp.example.com/api/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grant_type: "authorization_code" }),
      });
      const res = await postToken(req);
      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toBe("server_misconfigured");
    });

    it("fails closed with 500 when MCP_CLIENT_SECRET is unset", async () => {
      delete process.env.MCP_CLIENT_SECRET;
      const req = new Request("https://mcp.example.com/api/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grant_type: "authorization_code" }),
      });
      const res = await postToken(req);
      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toBe("server_misconfigured");
    });

    it("fails closed with 500 when MCP_CLIENT_SECRET is shorter than 16 chars", async () => {
      process.env.MCP_CLIENT_SECRET = "short-secret";
      const req = new Request("https://mcp.example.com/api/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grant_type: "authorization_code" }),
      });
      const res = await postToken(req);
      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toBe("server_misconfigured");
    });

    it("rejects request with invalid client credentials", async () => {
      const req = new Request("https://mcp.example.com/api/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `grant_type=authorization_code&client_id=${CLIENT_ID}&client_secret=wrong_secret&code=some_code`,
      });
      const res = await postToken(req);
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error).toBe("invalid_client");
    });

    it("accepts HTTP Basic authentication header", async () => {
      const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
      const req = new Request("https://mcp.example.com/api/oauth/token", {
        method: "POST",
        headers: {
          Authorization: `Basic ${basic}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=authorization_code&code=invalid_code",
      });
      const res = await postToken(req);
      expect(res.status).toBe(400); // Passed client auth, failed on invalid code
      const data = await res.json();
      expect(data.error).toBe("invalid_grant");
    });

    it("verifies PKCE challenge and issues access token", async () => {
      const verifier = "my-secret-pkce-verifier-12345678901234567890";
      const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");

      const code = createAuthCode({
        clientId: CLIENT_ID,
        redirectUri: "https://gemini.google.com/oauth",
        codeChallenge: challenge,
        codeChallengeMethod: "S256",
      });

      // 1. Fails if code_verifier is wrong
      const badReq = new Request("https://mcp.example.com/api/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          code,
          code_verifier: "wrong-verifier",
        }),
      });
      const badRes = await postToken(badReq);
      expect(badRes.status).toBe(400);
      const badData = await badRes.json();
      expect(badData.error).toBe("invalid_grant");
      expect(badData.error_description).toContain("code_verifier");

      // 2. Succeeds when code_verifier matches
      const goodReq = new Request("https://mcp.example.com/api/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          code,
          code_verifier: verifier,
        }),
      });
      const goodRes = await postToken(goodReq);
      expect(goodRes.status).toBe(200);
      const tokenData = await goodRes.json();
      expect(tokenData.access_token).toBeTruthy();
      expect(tokenData.token_type).toBe("Bearer");
      expect(tokenData.expires_in).toBe(3600);
      expect(tokenData.refresh_token).toBeTruthy();

      // Verify the issued token with verifyAccessToken
      const payload = verifyAccessToken(tokenData.access_token);
      expect(payload).not.toBeNull();
      expect(payload?.sub).toBe(CLIENT_ID);
      expect(payload?.type).toBe("access_token");
    });

    it("handles refresh_token grant", async () => {
      const refreshToken = createRefreshToken({ clientId: CLIENT_ID });
      const req = new Request("https://mcp.example.com/api/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          refresh_token: refreshToken,
        }),
      });
      const res = await postToken(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.access_token).toBeTruthy();
      expect(data.refresh_token).toBeTruthy();
    });

    it("handles OPTIONS on token endpoint", () => {
      const res = optionsToken();
      expect(res.status).toBe(204);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    });
  });

  describe("Token & Code tamper protection", () => {
    it("rejects tampered authorization code", () => {
      const code = createAuthCode({ clientId: CLIENT_ID, redirectUri: "https://example.com" });
      const tampered = code.slice(0, -4) + "abcd";
      expect(verifyAuthCode(tampered)).toBeNull();
    });

    it("rejects expired authorization code", () => {
      const code = createAuthCode({
        clientId: CLIENT_ID,
        redirectUri: "https://example.com",
        expiresInSeconds: -10, // expired
      });
      expect(verifyAuthCode(code)).toBeNull();
    });

    it("rejects tampered access token", () => {
      const token = createAccessToken({ clientId: CLIENT_ID });
      const tampered = token.slice(0, -5) + "xyz12";
      expect(verifyAccessToken(tampered)).toBeNull();
    });

    it("rejects expired access token", () => {
      const token = createAccessToken({ clientId: CLIENT_ID, expiresInSeconds: -5 });
      expect(verifyAccessToken(token)).toBeNull();
    });

    it("rejects tampered refresh token", () => {
      const token = createRefreshToken({ clientId: CLIENT_ID });
      const tampered = token.slice(0, -5) + "xyz12";
      expect(verifyRefreshToken(tampered)).toBeNull();
    });
  });
});
