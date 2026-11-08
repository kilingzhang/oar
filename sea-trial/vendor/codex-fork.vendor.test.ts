import { describe, expect, test } from "vitest";
import { codexInstallation, codexSession, promptAndWait } from "../../packages/oar/src/index.js";
import { startCodexAimock } from "../harness/aimock.js";
import { expectAvailable } from "./support/asserts.js";

/** SessionOptions.forkFrom against the real app-server: codex reports the new thread and its forkedFromId. */
describe.skipIf(process.env.OAR_TEST !== "codex-aimock")("codex session fork", () => {
  test("a fork opens a new thread whose forkedFromId names the source, and the source stays resumable", async () => {
    const env = await startCodexAimock((mock) => {
      mock.onMessage(/[\s\S]*/u, { content: "pong" });
    });
    const sessionEnv = env.env ?? {};
    try {
      const installation = await codexInstallation();
      expectAvailable(installation, "codex");
      const source = await codexSession(installation, { cwd: process.cwd(), env: sessionEnv });
      expect(await promptAndWait(source, "remember the word otter")).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
      const sourceId = source.id;
      await source.dispose();

      const forked = await codexSession(installation, { cwd: process.cwd(), env: sessionEnv, forkFrom: { sessionId: sourceId } });
      expect(forked.id).not.toBe(sourceId);
      expect(forked.graph().edges).toEqual([{ parent: sourceId, child: forked.id, via: "fork" }]);
      expect(await promptAndWait(forked, "what was the word?")).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
      await forked.dispose();

      // Forking reads the saved rollout; the source thread is still there.
      const resumed = await codexSession(installation, { cwd: process.cwd(), env: sessionEnv, resume: sourceId });
      expect(resumed.id).toBe(sourceId);
      expect(await promptAndWait(resumed, "still there?")).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
      await resumed.dispose();
    } finally {
      await env.stop();
    }
  }, 180_000);
});
