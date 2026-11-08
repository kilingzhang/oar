import assert from "node:assert/strict";
import { runTurn } from "../harness/session-controls.js";
import { assertPlacement } from "../harness/placement.js";
import type { TrialCase } from "../harness/runner.js";

export const sessionForkCases: readonly TrialCase[] = [
  {
    // A fork is either real (a new id, a fork edge to the source, both sides
    // still usable) or a typed loud rejection, never a fresh session
    // pretending to carry the source's history.
    id: "session.fork-or-loud-rejection",
    requires: ["installation", "session"],
    async run(subject) {
      const source = await subject.startSession();
      await runTurn(source, "remember me for the fork");
      const sourceId = source.id;
      const attempt = await subject.startSession({ forkFrom: { sessionId: sourceId } }).then(
        (session) => ({ kind: "forked" as const, session }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      );
      if (attempt.kind === "rejected") {
        assert.match(String(attempt.error), /fork/iu, "a runtime without fork must reject loudly, naming fork");
        await source.dispose();
        return;
      }
      const forked = attempt.session;
      try {
        assertPlacement(subject.runtime, forked);
        assert.notEqual(forked.id, sourceId, "a fork is a new session, not a reopen");
        // The turn makes the new stream's first root frame a fact on every
        // backend (claude records the edge when its first frame arrives).
        assert.deepEqual(await runTurn(forked, "hello fork"), { kind: "completed" });
        assert.deepEqual(forked.graph().edges, [{ parent: sourceId, child: forked.id, via: "fork" }], "the fork names its source in the graph");
        const firstFrame = forked.records().find((record) => record.kind === "frame");
        assert.ok(firstFrame?.kind === "frame", "the fork stream has a root frame");
        assert.deepEqual(
          firstFrame.body.events.filter((event) => event.kind === "session_linked"),
          [{ kind: "session_linked", parent: sourceId, child: forked.id, via: "fork" }],
          "the fork edge rides the first root frame",
        );
        assert.deepEqual(await runTurn(source, "hello source again"), { kind: "completed" }, "the source still works after a fork");
      } finally {
        await forked.dispose();
        await source.dispose();
      }
    },
  },
];
