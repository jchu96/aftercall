/**
 * MCP server scaffold — registers the 5 aftercall tools on an McpServer
 * instance, wires it through the Streamable HTTP transport.
 *
 * Stateless mode (sessionIdGenerator undefined): every /mcp request is
 * self-contained. This also sidesteps the `Mcp-Session-Id` coordination
 * concerns from Phase 1 Task 1.12.
 */
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Env } from "../env";
import { searchCalls } from "./tools/search_calls";
import { getCall } from "./tools/get_call";
import { findCall } from "./tools/find_call";
import { listFollowups } from "./tools/list_followups";
import { findActionItemsFor } from "./tools/find_action_items_for";
import { recentCalls } from "./tools/recent_calls";
import { answerFromTranscript } from "./tools/answer_from_transcript";

export function createMcpServer(env: Env): McpServer {
  const server = new McpServer(
    { name: "aftercall", version: "0.6.0" },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "search_calls",
    {
      title: "Search calls",
      description:
        "Find calls BY TOPIC or theme — what was discussed, decided, or mentioned across meetings (e.g. 'pricing pushback', 'the Vectorize migration'). Ranks calls by semantic similarity of their transcript content. Do NOT use this to look up a specific call by a URL, meeting code, title, or person's name — those are identifiers, not topics, and will return irrelevant matches; use `find_call` instead.",
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe(
            "A topic, theme, or phrase describing WHAT was talked about. Not a URL, meeting id, title, or name — if you have one of those, use `find_call`.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(25)
          .optional()
          .describe("Max number of calls to return (default 5, max 25)."),
      },
    },
    async (args) => (await searchCalls(args, env)) as any,
  );

  server.registerTool(
    "find_call",
    {
      title: "Find call by identifier",
      description:
        "Locate a SPECIFIC call from anything that names or points to it: a Google Meet / Zoom URL (`https://meet.google.com/www-jjni-xtd`), a bare meeting code (`www-jjni-xtd`), a hex id, a meeting title, or a participant name/email. Normalizes the input itself (you do NOT need to strip the URL scheme) and returns candidate calls with their exact `video_id`. Use this — not `search_calls` — whenever the user gives you something that identifies a particular meeting rather than describing a topic. After a single match, use its `video_id` with `get_call` or `answer_from_transcript`.",
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe(
            "A meeting URL, meeting code, hex id, title fragment, or participant name/email. Paste it verbatim — normalization is handled for you.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(25)
          .optional()
          .describe("Max candidate calls to return (default 10, max 25)."),
      },
    },
    async (args) => (await findCall(args, env)) as any,
  );

  server.registerTool(
    "get_call",
    {
      title: "Get call",
      description:
        "Fetch ONE call's full details (summary, participants, action items). Accepts an exact `video_id` (as returned by `find_call`/`search_calls`/`recent_calls`) and also tolerates a pasted Meet/Zoom URL, bare code, or title — it normalizes and falls back to fuzzy match, returning a disambiguation list if several calls match. To search by topic use `search_calls`; to resolve a tricky identifier first use `find_call`.",
      inputSchema: {
        video_id: z
          .string()
          .min(1)
          .describe(
            "Exact `video_id` from another tool's results (pass through unchanged), or an identifier to resolve (Meet/Zoom URL, meeting code, or title).",
          ),
      },
    },
    async (args) => (await getCall(args, env)) as any,
  );

  server.registerTool(
    "list_followups",
    {
      title: "List followups",
      description:
        "Query the Notion Followups database. Supports filtering by status (e.g. Inbox, In Progress, Done) and by source (e.g. Bluedot).",
      inputSchema: {
        status: z.string().optional().describe("Filter by Status select value."),
        source: z.string().optional().describe("Filter by Source select value."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Max rows to return (default 25, max 100)."),
      },
    },
    async (args) => (await listFollowups(args, env)) as any,
  );

  server.registerTool(
    "find_action_items_for",
    {
      title: "Find action items for a person",
      description:
        "Find action items assigned to a specific person across all indexed calls. Case-insensitive substring match on the owner field.",
      inputSchema: {
        person: z
          .string()
          .min(1)
          .describe("Name (or substring) of the action-item owner."),
        since: z
          .string()
          .optional()
          .describe("ISO date (YYYY-MM-DD) lower bound on call creation date."),
      },
    },
    async (args) => (await findActionItemsFor(args, env)) as any,
  );

  server.registerTool(
    "answer_from_transcript",
    {
      title: "Answer from transcript",
      description:
        "Ask a question about a specific call. Runs RAG over that call's transcript chunks (via Vectorize) and returns a grounded answer. Use this for 'when did we discuss X in this call?' or 'what did Y say about Z?' style queries against a single meeting.",
      inputSchema: {
        video_id: z
          .string()
          .min(1)
          .describe("The video_id of the call (e.g. `https://meet.google.com/abc-xyz`)."),
        question: z
          .string()
          .min(1)
          .describe("The natural-language question to answer from this transcript."),
      },
    },
    async (args) => (await answerFromTranscript(args, env)) as any,
  );

  server.registerTool(
    "recent_calls",
    {
      title: "Recent calls",
      description:
        "List calls from the last N days, newest first. Useful for 'what did I do last week?' style queries.",
      inputSchema: {
        days: z
          .number()
          .int()
          .min(1)
          .max(365)
          .optional()
          .describe("Look-back window in days (default 7, max 365)."),
      },
    },
    async (args) => (await recentCalls(args, env)) as any,
  );

  return server;
}

/**
 * Handle one `/mcp` request end-to-end: new transport per request (stateless),
 * connect McpServer, dispatch, return the transport's Response.
 */
export async function handleMcpRequest(request: Request, env: Env): Promise<Response> {
  const server = createMcpServer(env);
  const transport = new WebStandardStreamableHTTPServerTransport({
    // Stateless mode — no session state carried across requests.
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  await server.connect(transport);
  return transport.handleRequest(request);
}
