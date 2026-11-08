import type { AgentSession as PiAgentSession } from "@earendil-works/pi-coding-agent";
import type { FrameBody, SessionOptions } from "../../contracts/session.js";
import { newSessionLinks } from "../../shared/session-links.js";
import type { SessionKernel } from "../../shared/session-kernel.js";

/**
 * The first root frame of a pi session: the SDK's own report of the model
 * and thinking level in effect at open, plus a fork's lineage edge. The
 * model and level are the runtime's word, never the request echoed (the
 * mismatch checks in open.ts already rejected a request pi did not apply).
 */
export function piSessionOpenedBody(
  kernel: SessionKernel,
  session: PiAgentSession,
  forkFrom: SessionOptions["forkFrom"],
  openedModel: string | null,
): FrameBody {
  const links = forkFrom === undefined
    ? []
    : newSessionLinks(kernel, [{ parent: forkFrom.sessionId, child: session.sessionId, via: "fork" }]);
  return {
    type: "pi/session_opened",
    native: { sessionId: session.sessionId, model: openedModel, thinkingLevel: session.thinkingLevel },
    events: [
      ...links,
      ...(openedModel === null ? [] : [{ kind: "model" as const, model: openedModel }]),
      { kind: "effort", effort: session.thinkingLevel },
    ],
  };
}
