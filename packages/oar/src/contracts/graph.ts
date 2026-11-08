// ─── Session graph and cursor ─────────────────────────────────────────────
// Semantics: docs/spec/session-graph-and-cursor.md. Re-exported by ./records.ts.

/** True sessions only (docs/spec/session-graph-and-cursor.md): the root and the derived child sessions. Agent parent/child is `agentPath`, not a node. */
export interface SessionNode {
  readonly id: string;
}

export interface SessionEdge {
  readonly parent: string;
  readonly child: string;
  /** `tool_call`: the parent runtime spawned the child session. `fork`: the child is a fork of the parent conversation. */
  readonly via: "tool_call" | "fork";
}

export interface SessionGraph {
  readonly nodes: readonly SessionNode[];
  readonly edges: readonly SessionEdge[];
}

/** Resume reading after `afterSeq`; `-1` (or omitting the cursor) reads from the start. */
export interface Cursor {
  readonly sessionId: string;
  readonly afterSeq: number;
}
