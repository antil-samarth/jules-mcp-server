import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { registerJulesTools } from "@/lib/tools";
import * as jules from "@/lib/jules";

describe("registerJulesTools", () => {
  it("registers all expected Jules tools", () => {
    const server = new McpServer({ name: "test-server", version: "1.0.0" });
    registerJulesTools(server);

    const registered = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
    expect(Object.keys(registered)).toEqual(
      expect.arrayContaining([
        "jules_list_sources",
        "jules_create_session",
        "jules_get_session",
        "jules_list_activities",
        "jules_send_message",
        "jules_approve_plan",
      ]),
    );
  });

  it("handles successful tool execution formatting JSON output", async () => {
    const server = new McpServer({ name: "test-server", version: "1.0.0" });
    registerJulesTools(server);

    const registered = (server as unknown as {
      _registeredTools: Record<string, { handler: (args: unknown) => Promise<unknown> }>;
    })._registeredTools;

    const listSourcesSpy = vi.spyOn(jules, "listSources").mockResolvedValue({
      sources: [{ name: "sources/github/octocat/hello-world" }],
    });

    const result = (await registered.jules_list_sources!.handler({ pageSize: 10 })) as {
      content: { type: string; text: string }[];
      isError?: boolean;
    };

    expect(listSourcesSpy).toHaveBeenCalledWith({ pageSize: 10, pageToken: undefined });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      sources: [{ name: "sources/github/octocat/hello-world" }],
    });
  });

  it("catches JulesApiError and formats sanitized error response", async () => {
    const server = new McpServer({ name: "test-server", version: "1.0.0" });
    registerJulesTools(server);

    const registered = (server as unknown as {
      _registeredTools: Record<string, { handler: (args: unknown) => Promise<unknown> }>;
    })._registeredTools;

    vi.spyOn(jules, "getSession").mockRejectedValue(new jules.JulesApiError(404, "Session not found"));

    const result = (await registered.jules_get_session!.handler({ sessionId: "12345" })) as {
      content: { type: string; text: string }[];
      isError?: boolean;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe("Jules API error (404): Session not found");
  });

  it("catches JulesValidationError and formats clean error message", async () => {
    const server = new McpServer({ name: "test-server", version: "1.0.0" });
    registerJulesTools(server);

    const registered = (server as unknown as {
      _registeredTools: Record<string, { handler: (args: unknown) => Promise<unknown> }>;
    })._registeredTools;

    vi.spyOn(jules, "approvePlan").mockRejectedValue(new jules.JulesValidationError("Invalid sessionId."));

    const result = (await registered.jules_approve_plan!.handler({ sessionId: "../invalid" })) as {
      content: { type: string; text: string }[];
      isError?: boolean;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe("Invalid sessionId.");
  });

  it("catches JulesConfigError and returns generic configuration message", async () => {
    const server = new McpServer({ name: "test-server", version: "1.0.0" });
    registerJulesTools(server);

    const registered = (server as unknown as {
      _registeredTools: Record<string, { handler: (args: unknown) => Promise<unknown> }>;
    })._registeredTools;

    vi.spyOn(jules, "createSession").mockRejectedValue(new jules.JulesConfigError("JULES_API_KEY missing"));

    const result = (await registered.jules_create_session!.handler({
      prompt: "test",
      source: "owner/repo",
      branch: "main",
    })) as {
      content: { type: string; text: string }[];
      isError?: boolean;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe("The server is not configured to reach the Jules API.");
  });
});
