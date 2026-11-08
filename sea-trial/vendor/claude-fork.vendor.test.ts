import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { claudeInstallation, claudeSession, promptAndWait } from "../../packages/oar/src/index.js";
import { startClaudeAimock } from "../harness/aimock.js";
import { expectAvailable } from "./support/asserts.js";

/** SessionOptions.forkFrom against the real claude: a saved transcript forks under a new id, and the source stays usable. */
describe.skipIf(process.env.OAR_TEST !== "claude-aimock")("claude session fork", () => {
  test("a fork copies the saved conversation under a new id and leaves the source resumable", async () => {
    const env = await startClaudeAimock((mock) => {
      mock.onMessage(/[\s\S]*/u, { content: "pong" });
    });
    const cwd = await mkdtemp(path.join(tmpdir(), "oar-claude-fork-"));
    const config = await mkdtemp(path.join(tmpdir(), "oar-claude-fork-config-"));
    const sessionEnv = { ...env.env, CLAUDE_CONFIG_DIR: config };
    try {
      const installation = await claudeInstallation();
      expectAvailable(installation, "claude");
      const source = await claudeSession(installation, { cwd, env: sessionEnv });
      expect(await promptAndWait(source, "remember the word otter")).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
      const sourceId = source.id;
      await source.dispose();

      const forked = await claudeSession(installation, { cwd, env: sessionEnv, forkFrom: { sessionId: sourceId } });
      expect(forked.id).not.toBe(sourceId);
      expect(await promptAndWait(forked, "what was the word?")).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
      // claude writes its first root frame after the open readbacks; the turn
      // makes its arrival a fact.
      expect(forked.graph().edges).toEqual([{ parent: sourceId, child: forked.id, via: "fork" }]);
      await forked.dispose();

      // The fork wrote a new transcript; the source transcript is still there.
      const resumed = await claudeSession(installation, { cwd, env: sessionEnv, resume: sourceId });
      expect(resumed.id).toBe(sourceId);
      expect(await promptAndWait(resumed, "still there?")).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
      await resumed.dispose();
    } finally {
      await env.stop();
      await rm(cwd, { recursive: true, force: true, maxRetries: 5 });
      await rm(config, { recursive: true, force: true, maxRetries: 5 });
    }
  }, 180_000);
});
