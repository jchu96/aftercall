/**
 * MCP API handler — mounted by OAuthProvider at `/mcp`, bearer required.
 *
 * Phase 1 stub: returns 501 Not Implemented. Phase 2 replaces with the real
 * MCP Streamable HTTP transport from @modelcontextprotocol/sdk wiring through
 * ./tools.ts.
 */
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { Env } from "../env";

type Bindings = Env & { OAUTH_PROVIDER: OAuthHelpers };

export const mcpApiHandler = {
  async fetch(_request: Request, _env: Bindings, _ctx: ExecutionContext): Promise<Response> {
    return new Response(
      JSON.stringify({
        error: "not_implemented",
        message: "MCP transport scaffolding lands in Phase 2",
      }),
      { status: 501, headers: { "content-type": "application/json" } },
    );
  },
} satisfies ExportedHandler<Bindings>;
