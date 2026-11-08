import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import { piInstallation, promptAndWait } from "../../packages/oar/src/index.js";
import { piSessionDir } from "../../packages/oar/src/runtimes/pi/resolve.js";
import { startPiAimock } from "../harness/aimock.js";
import { expectAvailable } from "./support/asserts.js";
import { piSession } from "./support/pi-runtime.js";

/** SessionOptions.forkFrom against the real SDK: a new file whose header names the source, and the source stays resumable. */
describe.skipIf(process.env.OAR_TEST !== "pi-aimock")("pi session fork", () => {
  test("a fork writes a new session file pointing at the source, takes the requested name, and leaves the source resumable", async () => {
    const env = await startPiAimock((mock) => {
      mock.onMessage(/[\s\S]*/u, { content: "pong" });
    });
    const cwd = await mkdtemp(path.join(tmpdir(), "oar-pi-fork-"));
    try {
      const installation = await piInstallation();
      expectAvailable(installation, "pi");
      const agentDir = process.env.OAR_PI_AGENT_DIR ?? "";
      const source = await piSession(installation, { cwd, name: "source name" });
      expect(await promptAndWait(source, "remember the word otter")).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
      const sourceId = source.id;
      await source.dispose();

      const forked = await piSession(installation, { cwd, forkFrom: { sessionId: sourceId }, name: "fork name" });
      expect(forked.id).not.toBe(sourceId);
      expect(forked.graph().edges).toEqual([{ parent: sourceId, child: forked.id, via: "fork" }]);
      expect(await promptAndWait(forked, "what was the word?")).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
      const forkedId = forked.id;
      await forked.dispose();

      // pi's own list and the new file's header: the source path, the new id,
      // and the requested name over the one the fork copied.
      const sessions = await SessionManager.list(cwd, piSessionDir(cwd, agentDir));
      const sourcePath = sessions.find((info) => info.id === sourceId)?.path;
      const forkedInfo = sessions.find((info) => info.id === forkedId);
      expect(sourcePath).toBeDefined();
      expect(forkedInfo?.path).toBeDefined();
      const contents = await readFile(forkedInfo?.path ?? "", "utf8");
      const header: unknown = JSON.parse(contents.split("\n")[0] ?? "{}");
      expect(header).toMatchObject({ type: "session", id: forkedId, parentSession: sourcePath });
      expect(forkedInfo?.name).toBe("fork name");

      // Forking read the source file; the source is still its own session.
      const resumed = await piSession(installation, { cwd, resume: sourceId });
      expect(resumed.id).toBe(sourceId);
      expect(await promptAndWait(resumed, "still there?")).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
      await resumed.dispose();
    } finally {
      await env.stop();
      await rm(cwd, { recursive: true, force: true, maxRetries: 5 });
    }
  }, 180_000);
});
