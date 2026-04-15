import type { Env } from "./env";
import { handleWebhook, buildHandlerDeps } from "./handler";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleWebhook(request, buildHandlerDeps(env));
  },
};
