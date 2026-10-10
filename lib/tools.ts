import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  approvePlan,
  createSession,
  getSession,
  JulesApiError,
  JulesConfigError,
  JulesValidationError,
  listActivities,
  listSessions,
  listSources,
  sendMessage,
} from "@/lib/jules";

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

/** Converts any thrown value into a sanitised MCP tool error (never leaks keys or stacks). */
function fail(error: unknown): ToolResult {
  let message: string;
  if (error instanceof JulesApiError) {
    message = `Jules API error (${error.status}): ${error.message}`;
  } else if (error instanceof JulesValidationError) {
    message = error.message;
  } else if (error instanceof JulesConfigError) {
    console.error(`[tools] ${error.message}`);
    message = "The server is not configured to reach the Jules API.";
  } else {
    console.error("[tools] Unexpected error:", error instanceof Error ? error.message : "unknown");
    message = "An unexpected error occurred while calling Jules.";
  }
  return { isError: true, content: [{ type: "text", text: message }] };
}

async function run(action: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await action());
  } catch (error) {
    return fail(error);
  }
}

const sessionIdSchema = z
  .string()
  .min(1)
  .max(140)
  .describe("Jules session id, either `1234567` or `sessions/1234567`.");

const pageSizeSchema = z.number().int().min(1).max(100).default(30).describe("Max items to return (1-100).");
const pageTokenSchema = z.string().max(2048).optional().describe("`nextPageToken` from a previous response.");

export function registerJulesTools(server: McpServer): void {
  server.registerTool(
    "jules_list_sources",
    {
      title: "List Jules Sources",
      description:
        "List the GitHub repositories connected to Jules. Use the returned `name` " +
        "(e.g. `sources/github/owner/repo`) as the `source` when creating a session.",
      inputSchema: z.object({ pageSize: pageSizeSchema, pageToken: pageTokenSchema }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ pageSize, pageToken }) => run(() => listSources({ pageSize, pageToken })),
  );

  server.registerTool(
    "jules_list_sessions",
    {
      title: "List Jules Sessions",
      description:
        "List past and active Jules sessions. Use the returned session `name` or `id` with " +
        "`jules_get_session` or `jules_list_activities`.",
      inputSchema: z.object({ pageSize: pageSizeSchema, pageToken: pageTokenSchema }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ pageSize, pageToken }) => run(() => listSessions({ pageSize, pageToken })),
  );

  server.registerTool(
    "jules_create_session",
    {
      title: "Create Jules Session",
      description:
        "Start a Jules coding session on a connected repository. Returns the session (including its id). " +
        "Set `automationMode` to AUTO_CREATE_PR to have Jules open a pull request automatically, " +
        "or `requirePlanApproval` to pause for `jules_approve_plan` before it executes.",
      inputSchema: z.object({
        prompt: z.string().min(1).max(10_000).describe("The task for Jules to perform."),
        source: z
          .string()
          .min(3)
          .max(300)
          .describe("Repository source, e.g. `sources/github/owner/repo` (or shorthand `owner/repo`)."),
        branch: z.string().min(1).max(255).default("main").describe("Branch Jules should start from."),
        title: z.string().max(200).optional().describe("Optional human-readable session title."),
        automationMode: z
          .enum(["AUTOMATION_MODE_UNSPECIFIED", "AUTO_CREATE_PR"])
          .optional()
          .describe("AUTO_CREATE_PR makes Jules create a pull request when it finishes."),
        requirePlanApproval: z
          .boolean()
          .optional()
          .describe("If true, Jules waits for `jules_approve_plan` before executing its plan."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => run(() => createSession(args)),
  );

  server.registerTool(
    "jules_get_session",
    {
      title: "Get Jules Session",
      description:
        "Fetch a session's current state and outputs. When Jules has finished and opened a pull request, " +
        "`outputs[].pullRequest.url` contains its URL.",
      inputSchema: z.object({ sessionId: sessionIdSchema }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ sessionId }) => run(() => getSession(sessionId)),
  );

  server.registerTool(
    "jules_list_activities",
    {
      title: "List Jules Activities",
      description:
        "Retrieve the activity log of a session: generated plans, progress updates, messages, and " +
        "completion/failure events. Use it to monitor what Jules is doing.",
      inputSchema: z.object({ sessionId: sessionIdSchema, pageSize: pageSizeSchema, pageToken: pageTokenSchema }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ sessionId, pageSize, pageToken }) => run(() => listActivities({ sessionId, pageSize, pageToken })),
  );

  server.registerTool(
    "jules_send_message",
    {
      title: "Send Message to Jules",
      description: "Send feedback or follow-up instructions to an existing, active Jules session.",
      inputSchema: z.object({
        sessionId: sessionIdSchema,
        message: z.string().min(1).max(10_000).describe("The message to send to Jules."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    ({ sessionId, message }) => run(() => sendMessage({ sessionId, prompt: message })),
  );

  server.registerTool(
    "jules_approve_plan",
    {
      title: "Approve Jules Plan",
      description:
        "Approve the plan Jules generated so it starts executing. Only needed for sessions created with " +
        "`requirePlanApproval: true`; check `jules_list_activities` for the generated plan first.",
      inputSchema: z.object({ sessionId: sessionIdSchema }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ sessionId }) => run(() => approvePlan(sessionId)),
  );
}
