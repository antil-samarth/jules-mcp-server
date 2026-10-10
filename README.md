# Jules MCP Bridge

A stateless, authenticated [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server built on **Next.js (App Router)** that exposes the **Google Jules REST API** (`https://jules.googleapis.com/v1alpha`) as MCP tools.

Designed for zero-maintenance deployment on **Vercel Hobby** (free tier) and consumption by **Gemini CLI** and other MCP clients over Streamable HTTP at `/api/mcp`.

---

## Architecture & Security Model

```
┌────────────────────────────────┐         Authorization: Bearer <token>
│ Gemini CLI / Any MCP Client    │ ──────────────────────────────────────────────┐
└────────────────────────────────┘                                               │
                                                                                 ▼
                                                                     ┌──────────────────────┐
                                                                     │   /api/mcp/route.ts  │
                                                                     │   withBearerAuth()   │
                                                                     └──────────┬───────────┘
                                                       Missing / invalid token  │  Valid token
                                                       ┌────────────────────────┴─────────────┐
                                                       ▼                                      ▼
                                             ┌──────────────────┐                  ┌──────────────────────┐
                                             │ 401 Unauthorized │                  │     mcp-handler      │
                                             │ WWW-Authenticate │                  │   Streamable HTTP    │
                                             └──────────────────┘                  └──────────┬───────────┘
                                                                                              │
                                                                                              ▼
                                                                                   ┌──────────────────────┐
                                                                                   │   Registered Tools   │
                                                                                   │ (Zod input validated)│
                                                                                   └──────────┬───────────┘
                                                                                              │
                                                                           x-goog-api-key     ▼
                                                                     ┌────────────────────────────────────┐
                                                                     │ Google Jules REST API (v1alpha)    │
                                                                     │ https://jules.googleapis.com       │
                                                                     └────────────────────────────────────┘
```

- **Fail-Closed Gatekeeper**: Requests are intercepted before the MCP protocol handler runs. Unauthenticated requests are rejected with `401 Unauthorized` (or `500` if `MCP_AUTH_TOKEN` is not configured or shorter than 16 characters). Unauthenticated callers never consume Jules API quota.
- **Timing Safe**: Bearer tokens are compared using constant-time hashing (`SHA-256` + `crypto.timingSafeEqual`) to prevent length and timing side-channels.
- **Credential Isolation**: Your `JULES_API_KEY` stays strictly server-side. Errors returned by upstream Google APIs are sanitized and truncated before reaching MCP clients, ensuring keys and internal stack traces are never leaked.
- **Stateless HTTP**: Built with `mcp-handler` on MCP SDK v2. Requires no persistent SSE connection, Redis, or stateful infrastructure.

---

## Available MCP Tools

| Tool | Description | Inputs |
|---|---|---|
| `jules_list_sources` | List connected GitHub repositories. Use the returned `name` (e.g. `sources/github/owner/repo`) as `source` in session creation. | `pageSize` (1–100, default: 30), `pageToken` (optional) |
| `jules_create_session` | Start a Jules coding session on a connected repository. Supports automated PR creation and plan approval requirements. | `prompt` (required), `source` (`owner/repo` or `sources/github/owner/repo`), `branch` (default: "main"), `title` (optional), `automationMode` (`AUTO_CREATE_PR` or `AUTOMATION_MODE_UNSPECIFIED`), `requirePlanApproval` (boolean) |
| `jules_get_session` | Fetch session state, progress, and pull request output URL once completed. | `sessionId` (`123456` or `sessions/123456`) |
| `jules_list_activities` | Retrieve chronological session activities (plans, updates, messages, PR events). | `sessionId`, `pageSize`, `pageToken` |
| `jules_send_message` | Send follow-up instructions or feedback to an ongoing Jules session. | `sessionId`, `message` |
| `jules_approve_plan` | Approve a generated plan so Jules begins code execution (used when `requirePlanApproval: true`). | `sessionId` |

---

## Getting Started

### 1. Prerequisites

- **Node.js**: v20 or newer
- **Google Jules API Key**: Obtain from [Google Jules Settings](https://jules.google.com/settings)

### 2. Local Setup

Clone the repository and install dependencies:

```bash
git clone <repo-url>
cd jules-mcp-server
npm install
```

Generate a secure shared token for MCP client authentication:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Create `.env.local` by copying `.env.example`:

```bash
cp .env.example .env.local
```

Fill in `.env.local`:

```dotenv
JULES_API_KEY=your_google_jules_api_key_here
MCP_AUTH_TOKEN=your_generated_32_byte_hex_token_here
```

Start the local development server:

```bash
npm run dev
```

The MCP endpoint is accessible at `http://localhost:3000/api/mcp`.

---

## Testing with curl

### 1. Test Authentication Enforcement (Should Return 401)

Without token:
```bash
curl -i -X POST http://localhost:3000/api/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

With incorrect token:
```bash
curl -i -X POST http://localhost:3000/api/mcp \
  -H "Authorization: Bearer wrong-token" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Both return HTTP `401 Unauthorized` with `WWW-Authenticate: Bearer resource_metadata="<BASE_URL>/.well-known/oauth-protected-resource"`.

### 2. List Available Tools (200 OK)

```bash
curl -s -X POST http://localhost:3000/api/mcp \
  -H "Authorization: Bearer <MCP_AUTH_TOKEN>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

### 3. Call a Tool (e.g. `jules_list_sources`)

```bash
curl -s -X POST http://localhost:3000/api/mcp \
  -H "Authorization: Bearer <MCP_AUTH_TOKEN>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {
      "name": "jules_list_sources",
      "arguments": {
        "pageSize": 5
      }
    }
  }'
```

---

## Connecting Clients

### Gemini Web App (gemini.google.com)

Gemini's web app discovers authentication using standard **OAuth 2.1 / RFC 9728** metadata:

1. When adding a server in Gemini, enter your server URL:
   `https://<your-vercel-domain>.vercel.app/api/mcp`
2. Provide your OAuth credentials:
   - **Client ID**: Your `MCP_CLIENT_ID` (from environment variables)
   - **Client Secret**: Your `MCP_CLIENT_SECRET` (from environment variables)
3. Gemini discovers metadata at `/.well-known/oauth-protected-resource` and redirects to `/api/oauth/authorize`.
4. Our lightweight OAuth server auto-approves the request, verifies PKCE (`S256`), and issues an OAuth access token through `/api/oauth/token`.

### Gemini CLI

Add the server to your Gemini CLI configuration (`~/.gemini/settings.json` or project `settings.json`):

```json
{
  "mcpServers": {
    "jules": {
      "httpUrl": "https://<your-vercel-domain>.vercel.app/api/mcp",
      "headers": {
        "Authorization": "Bearer <MCP_AUTH_TOKEN>"
      }
    }
  }
}
```

### Other MCP Clients (e.g., Claude Desktop / Custom HTTP Clients)

Configure the client to connect via Streamable HTTP:
- **URL**: `https://<your-domain>/api/mcp`
- **Headers**:
  - `Authorization`: `Bearer <MCP_AUTH_TOKEN>`

### Optional: Browser Clients & CORS

If connecting from an in-browser web application, specify allowed origins in `.env`:

```dotenv
MCP_CORS_ORIGINS=https://app.example.com,http://localhost:5173
```

Set to `*` to allow any origin. If unset, CORS headers are omitted for security.

---

## Deployment to Vercel

1. Push your repository to GitHub / GitLab.
2. Import the project into [Vercel](https://vercel.com).
3. In **Project Settings** > **Environment Variables**, add:
   - `JULES_API_KEY`: Your secret Google Jules API key.
   - `MCP_AUTH_TOKEN`: Your random secret token (32+ chars).
   - *(Optional)* `MCP_CORS_ORIGINS`: If web apps will connect.
4. Deploy with `vercel --prod` or git push.

> [!NOTE]
> Vercel Hobby accounts have a 60-second maximum duration per function, which is configured in `app/api/mcp/route.ts` via `export const maxDuration = 60;`.

---

## Verification & Scripts

```bash
# Typecheck TypeScript strictly
npm run typecheck

# Run unit tests (Vitest)
npm test

# Build Next.js production bundle
npm run build
```
