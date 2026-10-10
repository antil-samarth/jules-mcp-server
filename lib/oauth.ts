import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { safeEqual } from "./auth";

export interface AuthCodePayload {
  clientId: string;
  redirectUri: string;
  codeChallenge?: string | undefined;
  codeChallengeMethod?: "S256" | "plain" | string | undefined;
  exp: number; // Unix timestamp in ms
  nonce: string;
}

export interface AccessTokenPayload {
  sub: string;
  type: "access_token";
  scope: string;
  iat: number; // Unix timestamp in seconds
  exp: number; // Unix timestamp in seconds
}

export interface RefreshTokenPayload {
  sub: string;
  type: "refresh_token";
  scope: string;
  iat: number; // Unix timestamp in seconds
  exp: number; // Unix timestamp in seconds
}

function getOAuthSigningSecret(): string {
  const secret = process.env.MCP_CLIENT_SECRET || process.env.MCP_AUTH_TOKEN;
  if (!secret || secret.trim().length === 0) {
    return "jules-mcp-internal-oauth-fallback-signing-secret-32b";
  }
  return secret.trim();
}

function hmacSha256(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data, "utf8").digest("base64url");
}

function base64UrlEncode(data: string): string {
  return Buffer.from(data, "utf8").toString("base64url");
}

function base64UrlDecode(data: string): string {
  return Buffer.from(data, "base64url").toString("utf8");
}

/**
 * Dynamically derives the public base URL from explicit env or incoming request headers.
 */
export function getBaseUrl(req: Request): string {
  if (process.env.APP_URL?.trim()) {
    return process.env.APP_URL.trim().replace(/\/+$/, "");
  }

  const proto = req.headers.get("x-forwarded-proto") || "https";
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host");

  if (host) {
    const isLocal = host.startsWith("localhost") || host.startsWith("127.0.0.1") || host.includes("localhost:");
    const effectiveProto = isLocal ? (req.headers.get("x-forwarded-proto") || "http") : proto;
    return `${effectiveProto}://${host}`.replace(/\/+$/, "");
  }

  if (process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim()) {
    const url = process.env.VERCEL_PROJECT_PRODUCTION_URL.trim();
    const withProto = url.startsWith("http") ? url : `https://${url}`;
    return withProto.replace(/\/+$/, "");
  }

  if (process.env.VERCEL_URL?.trim()) {
    const url = process.env.VERCEL_URL.trim();
    const withProto = url.startsWith("http") ? url : `https://${url}`;
    return withProto.replace(/\/+$/, "");
  }

  try {
    const parsed = new URL(req.url);
    return `${parsed.protocol}//${parsed.host}`.replace(/\/+$/, "");
  } catch {
    return "http://localhost:3000";
  }
}

/**
 * Creates a signed, short-lived authorization code containing client and PKCE metadata.
 */
export function createAuthCode(params: {
  clientId: string;
  redirectUri: string;
  codeChallenge?: string | undefined;
  codeChallengeMethod?: string | undefined;
  expiresInSeconds?: number | undefined;
}): string {
  const payload: AuthCodePayload = {
    clientId: params.clientId,
    redirectUri: params.redirectUri,
    codeChallenge: params.codeChallenge,
    codeChallengeMethod: params.codeChallengeMethod || (params.codeChallenge ? "S256" : undefined),
    exp: Date.now() + (params.expiresInSeconds ?? 600) * 1000,
    nonce: randomBytes(16).toString("hex"),
  };
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const sig = hmacSha256(payloadB64, getOAuthSigningSecret());
  return `${payloadB64}.${sig}`;
}

/**
 * Verifies the signature and expiration of an authorization code.
 */
export function verifyAuthCode(code: string): AuthCodePayload | null {
  const parts = code.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts as [string, string];
  const expectedSig = hmacSha256(payloadB64, getOAuthSigningSecret());
  if (Buffer.from(sig).length !== Buffer.from(expectedSig).length) return null;
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;

  try {
    const payload = JSON.parse(base64UrlDecode(payloadB64)) as AuthCodePayload;
    if (typeof payload.exp !== "number" || payload.exp < Date.now()) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

/**
 * Verifies PKCE code_verifier against the challenge stored in the authorization code.
 */
export function verifyPkce(verifier: string, challenge: string, method?: string): boolean {
  if (method === "plain") {
    if (Buffer.from(verifier).length !== Buffer.from(challenge).length) return false;
    return timingSafeEqual(Buffer.from(verifier), Buffer.from(challenge));
  }
  // Default to S256 per RFC 7636
  const hash = createHash("sha256").update(verifier, "ascii").digest("base64url");
  if (Buffer.from(hash).length !== Buffer.from(challenge).length) return false;
  return timingSafeEqual(Buffer.from(hash), Buffer.from(challenge));
}

/**
 * Creates a signed OAuth access token (valid for 1 hour by default).
 */
export function createAccessToken(params: {
  clientId: string;
  scope?: string | undefined;
  expiresInSeconds?: number | undefined;
}): string {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + (params.expiresInSeconds ?? 3600);
  const payload: AccessTokenPayload = {
    sub: params.clientId,
    type: "access_token",
    scope: params.scope ?? "mcp",
    iat: now,
    exp,
  };
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const sig = hmacSha256(payloadB64, getOAuthSigningSecret());
  return `${payloadB64}.${sig}`;
}

/**
 * Verifies an OAuth access token, returning the payload if valid and unexpired.
 */
export function verifyAccessToken(token: string): AccessTokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts as [string, string];
  const expectedSig = hmacSha256(payloadB64, getOAuthSigningSecret());
  if (Buffer.from(sig).length !== Buffer.from(expectedSig).length) return null;
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;

  try {
    const payload = JSON.parse(base64UrlDecode(payloadB64)) as AccessTokenPayload;
    if (payload.type !== "access_token") return null;
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== "number" || payload.exp < now) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

/**
 * Creates a signed OAuth refresh token (valid for 30 days by default).
 */
export function createRefreshToken(params: {
  clientId: string;
  scope?: string | undefined;
  expiresInSeconds?: number | undefined;
}): string {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + (params.expiresInSeconds ?? 30 * 24 * 3600);
  const payload: RefreshTokenPayload = {
    sub: params.clientId,
    type: "refresh_token",
    scope: params.scope ?? "mcp",
    iat: now,
    exp,
  };
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const sig = hmacSha256(payloadB64, getOAuthSigningSecret());
  return `${payloadB64}.${sig}`;
}

/**
 * Verifies an OAuth refresh token.
 */
export function verifyRefreshToken(token: string): RefreshTokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts as [string, string];
  const expectedSig = hmacSha256(payloadB64, getOAuthSigningSecret());
  if (Buffer.from(sig).length !== Buffer.from(expectedSig).length) return null;
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;

  try {
    const payload = JSON.parse(base64UrlDecode(payloadB64)) as RefreshTokenPayload;
    if (payload.type !== "refresh_token") return null;
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== "number" || payload.exp < now) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}
