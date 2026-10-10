import { createAuthCode } from "@/lib/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request) {
  const url = new URL(req.url);
  const clientId = url.searchParams.get("client_id");
  const redirectUri = url.searchParams.get("redirect_uri");
  const state = url.searchParams.get("state");
  const codeChallenge = url.searchParams.get("code_challenge") ?? undefined;
  const codeChallengeMethod = url.searchParams.get("code_challenge_method") ?? undefined;
  const responseType = url.searchParams.get("response_type");

  if (!clientId) {
    return Response.json(
      { error: "invalid_request", error_description: "Missing client_id" },
      { status: 400 },
    );
  }

  const expectedClientId = process.env.MCP_CLIENT_ID?.trim();
  if (expectedClientId && clientId !== expectedClientId) {
    return Response.json(
      { error: "unauthorized_client", error_description: "Invalid client_id" },
      { status: 400 },
    );
  }

  if (!redirectUri) {
    return Response.json(
      { error: "invalid_request", error_description: "Missing redirect_uri" },
      { status: 400 },
    );
  }

  try {
    const parsed = new URL(redirectUri);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return Response.json(
        { error: "invalid_request", error_description: "Invalid redirect_uri protocol" },
        { status: 400 },
      );
    }
  } catch {
    return Response.json(
      { error: "invalid_request", error_description: "Malformed redirect_uri" },
      { status: 400 },
    );
  }

  if (responseType && responseType !== "code") {
    const errorUrl = new URL(redirectUri);
    errorUrl.searchParams.set("error", "unsupported_response_type");
    if (state) errorUrl.searchParams.set("state", state);
    return Response.redirect(errorUrl.toString(), 302);
  }

  const code = createAuthCode({
    clientId,
    redirectUri,
    codeChallenge,
    codeChallengeMethod,
  });

  const redirectUrl = new URL(redirectUri);
  redirectUrl.searchParams.set("code", code);
  if (state) {
    redirectUrl.searchParams.set("state", state);
  }

  return new Response(null, {
    status: 302,
    headers: {
      Location: redirectUrl.toString(),
      "Cache-Control": "no-store",
    },
  });
}
