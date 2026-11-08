import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test } from "vitest";
import type { Session } from "../../packages/oar/src/contracts/session.js";
import { UnsupportedOptionError } from "../../packages/oar/src/contracts/errors.js";
import { openPiAgentSession } from "../../packages/oar/src/runtimes/pi/open.js";
import { piSessionDir } from "../../packages/oar/src/runtimes/pi/resolve.js";
import { createPiSession } from "../../packages/oar/src/runtimes/pi/session.js";

/*
 * pi forks with its own SessionManager.forkFrom: a new session file whose
 * header names the source file, holding a copy of the source's entries. The
 * adapter records that lineage on the new stream's first root frame, with
 * the runtime's own ids, and gives the fork a new id of its own.
 */

interface PiForkSetup {
  readonly manager: typeof SessionManager;
  readonly cwd: string;
  readonly sessionDir: string;
  readonly parentPath: string;
  readonly parentFile: string;
}

const previousAgentDir = process.env.OAR_PI_AGENT_DIR;

afterEach(() => {
  if (previousAgentDir === undefined) {
    delete process.env.OAR_PI_AGENT_DIR;
  } else {
    process.env.OAR_PI_AGENT_DIR = previousAgentDir;
  }
});

async function tempProject(): Promise<{ cwd: string; sessionDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "oar-pi-fork-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  await mkdir(cwd, { recursive: true });
  const sessionDir = piSessionDir(cwd, agentDir);
  await mkdir(sessionDir, { recursive: true });
  process.env.OAR_PI_AGENT_DIR = agentDir;
  return { cwd, sessionDir };
}

/** A persisted parent session with one user message, and its file's contents. */
async function parentSession(): Promise<PiForkSetup> {
  const { cwd, sessionDir } = await tempProject();
  const sdk = await import("@earendil-works/pi-coding-agent");
  const { SessionManager: manager } = sdk;
  const parent = manager.create(cwd, sessionDir, { id: "parent-session" });
  // pi writes a new session file on its first user/assistant message; a
  // custom entry alone stays in memory.
  parent.appendMessage({ role: "user", content: "fork me", timestamp: Date.now() });
  const [info] = await manager.list(cwd, sessionDir);
  if (info === undefined) { throw new Error("the parent session file was not written"); }
  return { manager, cwd, sessionDir, parentPath: info.path, parentFile: await readFile(info.path, "utf8") };
}

const linkedEvents = (session: Session): unknown[] =>
  session.records().flatMap((record) =>
    record.kind === "frame" ? record.body.events.filter((event) => event.kind === "session_linked") : []);

async function expectNativeForkFile(setup: PiForkSetup, id: string): Promise<void> {
  const files = await setup.manager.list(setup.cwd, setup.sessionDir);
  const child = files.find((entry) => entry.id === id);
  if (child === undefined) { throw new Error("pi wrote no file for the fork"); }
  const text = await readFile(child.path, "utf8");
  const header: unknown = JSON.parse(text.split("\n", 1)[0] ?? "null");
  expect(header).toMatchObject({ type: "session", id, parentSession: setup.parentPath });
}

test("pi forks through SessionManager.forkFrom: a new id, a native parent header, and a fork edge", async () => {
  const setup = await parentSession();
  const session = await createPiSession()(
    { kind: "available", via: "bundled" },
    { cwd: setup.cwd, forkFrom: { sessionId: "parent-session" }, name: "forked" },
  );
  try {
    expect(session.id).not.toBe("parent-session");
    expect(session.graph().edges).toEqual([{ parent: "parent-session", child: session.id, via: "fork" }]);
    expect(linkedEvents(session)).toEqual([{ kind: "session_linked", parent: "parent-session", child: session.id, via: "fork" }]);
    await expectNativeForkFile(setup, session.id);
    expect(await readFile(setup.parentPath, "utf8")).toBe(setup.parentFile);
  } finally { await session.dispose(); }
});

test("fork and resume are mutually exclusive on pi, before the SDK loads", async () => {
  await expect(createPiSession()(
    { kind: "available", via: "bundled" },
    { cwd: "/tmp", resume: "old-id", forkFrom: { sessionId: "parent-session" } },
  )).rejects.toMatchObject({ name: "UnsupportedOptionError", option: "forkFrom", message: "forkFrom and resume are mutually exclusive" });
});

test("pi forks the whole saved conversation, so forkFrom.through is refused rather than dropped", async () => {
  const opening = createPiSession()(
    { kind: "available", via: "bundled" },
    { cwd: "/tmp", forkFrom: { sessionId: "parent-session", through: "leaf-1" } },
  );
  await expect(opening).rejects.toBeInstanceOf(UnsupportedOptionError);
  await expect(opening).rejects.toMatchObject({ option: "forkFrom", message: "pi forks the whole saved conversation; forkFrom.through is not supported" });
});

test("a missing pi fork source is the same typed not-found error as a missing resume", async () => {
  const { cwd } = await tempProject();
  const failure: unknown = await openPiAgentSession({ cwd, forkFrom: { sessionId: "missing-session" } }).catch((error: unknown) => error);
  expect(failure).toMatchObject({ name: "SessionNotFoundError", sessionId: "missing-session", cause: { method: "SessionManager.list" } });
});
