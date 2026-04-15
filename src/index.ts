import type { Env } from "./env";

// Phase 2 stub — full handler arrives in Phase 3.
// Phase 2 verified storage layer (D1 + Vectorize); see scripts/smoke-vectorize.ts.
export default {
  async fetch(_request: Request, _env: Env): Promise<Response> {
    return new Response("Not yet implemented", { status: 501 });
  },
};
