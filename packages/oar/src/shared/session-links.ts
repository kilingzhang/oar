/* oxlint-disable import/prefer-default-export -- Named helpers shared by ACP, Codex, Claude and Pi recorders. */
import type { FrameBody, RuntimeEventBody, SessionEdge } from "../contracts/session.js";
import type { SessionKernel } from "./session-kernel.js";

/** Add lineage to its first source frame, including at most one copy within that frame. */
export function newSessionLinks(kernel: SessionKernel, edges: readonly SessionEdge[]): Extract<RuntimeEventBody, { readonly kind: "session_linked" }>[] {
  const known = kernel.graph().edges;
  const added: Extract<RuntimeEventBody, { readonly kind: "session_linked" }>[] = [];
  for (const edge of edges) {
    const same = (candidate: SessionEdge): boolean => candidate.parent === edge.parent && candidate.child === edge.child;
    if (!known.some((candidate) => same(candidate)) && !added.some((candidate) => same(candidate))) { added.push(kernel.link(edge)); }
  }
  return added;
}

/**
 * Attach pending open lineage to a root frame's body, once: the first root
 * frame carries each edge and later frames carry none. Returns the body to
 * record and the links still pending.
 */
export function withOpenLinks(kernel: SessionKernel, body: FrameBody, links: readonly SessionEdge[], root: boolean): { readonly body: FrameBody; readonly openLinks: readonly SessionEdge[] } {
  const added = root && links.length > 0 ? newSessionLinks(kernel, links) : [];
  return added.length === 0
    ? { body, openLinks: links }
    : { body: { ...body, events: [...added, ...body.events] }, openLinks: [] };
}
