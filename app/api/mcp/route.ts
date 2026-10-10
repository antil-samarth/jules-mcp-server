import { createMcpHandler } from "mcp-handler";
import { withBearerAuth } from "@/lib/auth";
import { registerJulesTools } from "@/lib/tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const mcp = createMcpHandler(
  (server) => {
    registerJulesTools(server);
  },
  {
    serverInfo: {
      name: "jules-mcp",
      version: "1.0.0",
    },
  },
);

const handler = withBearerAuth(mcp);

export { handler as GET, handler as POST, handler as DELETE, handler as OPTIONS };