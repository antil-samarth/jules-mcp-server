import { safeEqual } from "@/lib/auth";
import {
  createAccessToken,
  createRefreshToken,
  verifyAuthCode,
  verifyPkce,
  verifyRefreshToken,
} from "@/lib/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jsonError(
  status: number,
  error: string,
  description?: string,
  headers: Record<string, string> = {},
) {
  return Response.json(
    {
      error,
      ...(description ? { error_description: description } : {}),
    },
    {
      status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
        ...headers,
      },
    },
  );
}

export async function POST(req: Request) {
  let clientId: string | undefined;
  let clientSecret: string | undefined;

  // 1. Support client_secret_basic (Authorization: Basic base64(client_id:client_secret))
  const authHeader = req.headers.get("authorization");
  if (authHeader && authHeader.toLowerCase().startsWith("basic ")) {
    try {
      const b64 = authHeader.slice(6).trim();
      const decoded = Buffer.from(b64, "base64").toString("utf8");
      const colonIdx = decoded.indexOf(":");
      if (colonIdx !== -1) {
        clientId = decodeURIComponent(decoded.slice(0, colonIdx));
        clientSecret = decodeURIComponent(decoded.slice(colonIdx + 1));
      }
    } catch {}
  }

  // 2. Parse body (supports application/x-www-form-urlencoded and application/json)
  const contentType = req.headers.get("content-type") || "";
  const bodyParams: Record<string, string> = {};

  if (contentType.includes("application/json")) {
    try {
      const parsed = (await req.json()) as Record<string, unknown>;
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "string") bodyParams[k] = v;
      }
    } catch {
      return jsonError(400, "invalid_request", "Invalid JSON body");
    }
  } else {
    try {
      const text = await req.text();
      const params = new URLSearchParams(text);
      for (const [k, v] of params.entries()) {
        bodyParams[k] = v;
      }
    } catch {
      return jsonError(400, "invalid_request", "Invalid form body");
    }
  }

  // 3. Fallback to client_secret_post from body
  if (!clientId && bodyParams.client_id) {
    clientId = bodyParams.client_id;
  }
  if (!clientSecret && bodyParams.client_secret) {
    clientSecret = bodyParams.client_secret;
  }

  // 4. Validate client credentials
  const expectedClientId = process.env.MCP_CLIENT_ID?.trim();
  const expectedClientSecret = process.env.MCP_CLIENT_SECRET?.trim();

  if (expectedClientId) {
    if (!clientId || clientId !== expectedClientId) {
      return jsonError(401, "invalid_client", "Client ID does not match", {
        "WWW-Authenticate": 'Basic realm="oauth"',
      });
    }
  }

  if (expectedClientSecret) {
    if (!clientSecret || !safeEqual(clientSecret, expectedClientSecret)) {
      return jsonError(401, "invalid_client", "Invalid client secret", {
        "WWW-Authenticate": 'Basic realm="oauth"',
      });
    }
  }

  const grantType = bodyParams.grant_type;
  if (!grantType) {
    return jsonError(400, "invalid_request", "Missing grant_type");
  }

  // 5. Handle grant_type=authorization_code
  if (grantType === "authorization_code") {
    const code = bodyParams.code;
    if (!code) {
      return jsonError(400, "invalid_request", "Missing authorization code");
    }

    const payload = verifyAuthCode(code);
    if (!payload) {
      return jsonError(400, "invalid_grant", "Invalid or expired authorization code");
    }

    if (clientId && payload.clientId !== clientId) {
      return jsonError(400, "invalid_grant", "Client ID mismatch with authorization code");
    }

    const redirectUri = bodyParams.redirect_uri;
    if (redirectUri && payload.redirectUri !== redirectUri) {
      return jsonError(400, "invalid_grant", "Redirect URI mismatch");
    }

    // Verify PKCE if a challenge was bound to the code
    if (payload.codeChallenge) {
      const codeVerifier = bodyParams.code_verifier;
      if (!codeVerifier) {
        return jsonError(400, "invalid_grant", "Missing code_verifier for PKCE");
      }
      if (!verifyPkce(codeVerifier, payload.codeChallenge, payload.codeChallengeMethod)) {
        return jsonError(400, "invalid_grant", "Invalid code_verifier for PKCE");
      }
    }

    const effectiveClient = clientId || payload.clientId || "client";
    const accessToken = createAccessToken({ clientId: effectiveClient, scope: "mcp" });
    const refreshToken = createRefreshToken({ clientId: effectiveClient, scope: "mcp" });

    return Response.json(
      {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: refreshToken,
        scope: "mcp",
      },
      {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }

  // 6. Handle grant_type=refresh_token
  if (grantType === "refresh_token") {
    const refreshToken = bodyParams.refresh_token;
    if (!refreshToken) {
      return jsonError(400, "invalid_request", "Missing refresh_token");
    }

    const payload = verifyRefreshToken(refreshToken);
    if (!payload) {
      return jsonError(400, "invalid_grant", "Invalid or expired refresh token");
    }

    const effectiveClient = clientId || payload.sub || "client";
    const accessToken = createAccessToken({ clientId: effectiveClient, scope: "mcp" });
    const newRefreshToken = createRefreshToken({ clientId: effectiveClient, scope: "mcp" });

    return Response.json(
      {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: newRefreshToken,
        scope: "mcp",
      },
      {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }

  return jsonError(400, "unsupported_grant_type", `Unsupported grant_type: ${grantType}`);
}

export function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Max-Age": "86400",
    },
  });
}
