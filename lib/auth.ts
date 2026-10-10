import { createHash, timingSafeEqual } from "node:crypto";
import { getBaseUrl, verifyAccessToken } from "@/lib/oauth";

/**
 * Bearer-token authentication (and minimal CORS) middleware for Fetch-style route handlers.
 *
 * Guarantees:
 *  - Every non-OPTIONS request must carry `Authorization: Bearer <MCP_AUTH_TOKEN>`.
 *  - The wrapped handler (and therefore every MCP tool / Jules call) is NEVER invoked
 *    unless the token check passes.
 *  - If `MCP_AUTH_TOKEN` is missing or weak, the endpoint fails closed with a 500.
 *  - CORS preflight (`OPTIONS`) is answered directly with 204 and never requires auth,
 *    because browsers cannot attach credentials to preflights. It exposes no data.
 */

export type RouteHandler = (req: Request) => Response | Promise<Response>;

const MIN_TOKEN_LENGTH = 16;
const BEARER_PATTERN = /^Bearer\s+(\S+)$/i;

const CORS_ALLOWED_METHODS = "GET, POST, DELETE, OPTIONS";
const CORS_ALLOWED_HEADERS =
  "Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID";
const CORS_EXPOSED_HEADERS = "Mcp-Session-Id, WWW-Authenticate";
const CORS_MAX_AGE_SECONDS = "86400";

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Constant-time string comparison that does not leak length or content via timing. */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

/** Returns the configured token if it is present and strong enough, otherwise `undefined`. */
function getConfiguredToken(): string | undefined {
  const token = process.env.MCP_AUTH_TOKEN?.trim();
  return token && token.length >= MIN_TOKEN_LENGTH ? token : undefined;
}

/** Extracts the bearer token from the request, or `undefined` if absent/malformed. */
export function extractBearerToken(req: Request): string | undefined {
  const header = req.headers.get("authorization");
  if (!header) return undefined;
  return BEARER_PATTERN.exec(header.trim())?.[1];
}

/**
 * Builds CORS headers for the request's `Origin` if (and only if) it is allow-listed via
 * `MCP_CORS_ORIGINS`. Returns an empty object otherwise (same-origin / non-browser clients).
 */
export function corsHeadersFor(req: Request): Record<string, string> {
  const configured = process.env.MCP_CORS_ORIGINS;
  const origin = req.headers.get("origin");
  if (!configured || !origin) return {};

  const allowed = configured
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (allowed.includes("*")) {
    return { "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": CORS_EXPOSED_HEADERS };
  }
  if (allowed.includes(origin)) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Expose-Headers": CORS_EXPOSED_HEADERS,
      Vary: "Origin",
    };
  }
  return {};
}

function jsonResponse(status: number, body: Record<string, string>, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra },
  });
}

function withHeaders(response: Response, extra: Record<string, string>): Response {
  if (Object.keys(extra).length === 0) return response;
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(extra)) {
    if (key.toLowerCase() === "vary") headers.append("Vary", value);
    else headers.set(key, value);
  }
  // Re-wrap with the original body stream so streaming (SSE) responses keep working.
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** Answers a CORS preflight. No authentication, no body, no side effects. */
export function handlePreflight(req: Request): Response {
  const cors = corsHeadersFor(req);
  const headers: Record<string, string> = { "Cache-Control": "no-store", ...cors };
  if (cors["Access-Control-Allow-Origin"]) {
    headers["Access-Control-Allow-Methods"] = CORS_ALLOWED_METHODS;
    headers["Access-Control-Allow-Headers"] = CORS_ALLOWED_HEADERS;
    headers["Access-Control-Max-Age"] = CORS_MAX_AGE_SECONDS;
  }
  return new Response(null, { status: 204, headers });
}

/** Wraps a route handler so it only runs for requests with a valid Bearer token. */
export function withBearerAuth(handler: RouteHandler): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return handlePreflight(req);

    const cors = corsHeadersFor(req);

    const expected = getConfiguredToken();
    const hasStaticConfig = Boolean(process.env.MCP_AUTH_TOKEN?.trim());
    const hasOAuthConfig = Boolean(process.env.MCP_CLIENT_SECRET?.trim() || process.env.MCP_CLIENT_ID?.trim());

    if (hasStaticConfig && !expected) {
      console.error(
        `[auth] MCP_AUTH_TOKEN is shorter than ${MIN_TOKEN_LENGTH} characters; refusing all requests.`,
      );
      return jsonResponse(500, { error: "server_misconfigured" }, cors);
    }

    if (!expected && !hasOAuthConfig) {
      console.error(
        `[auth] MCP_AUTH_TOKEN is missing or shorter than ${MIN_TOKEN_LENGTH} characters; refusing all requests.`,
      );
      return jsonResponse(500, { error: "server_misconfigured" }, cors);
    }

    const provided = extractBearerToken(req);
    const validStatic = expected && provided ? safeEqual(provided, expected) : false;
    const validOAuth = provided ? verifyAccessToken(provided) !== null : false;

    if (!validStatic && !validOAuth) {
      const baseUrl = getBaseUrl(req);
      return jsonResponse(401, { error: "unauthorized" }, {
        "WWW-Authenticate": `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`,
        ...cors,
      });
    }

    return withHeaders(await handler(req), cors);
  };
}
