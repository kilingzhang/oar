import { afterEach, expect, test, vi } from "vitest";
import { UnsupportedOptionError } from "../../packages/oar/src/contracts/errors.js";
import { claudeSession } from "../../packages/oar/src/runtimes/claude/session.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { fakeLineProcess, type FakeLineProcess } from "../fixtures/fake-line-process.js";

const spawnLineProcess = vi.hoisted(() => vi.fn<(command: string, args: readonly string[]) => FakeLineProcess>());
vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));
const installation = { kind: "available", via: "executable", command: "claude", version: "2.1.319" } as const;
const parent = "11111111-1111-4111-8111-111111111111";

afterEach(() => { spawnLineProcess.mockReset(); });

const line = (value: Record<string, unknown>): string => `${JSON.stringify(value)}\n`;

/** A claude that answers the fork's two private readbacks: initialize, then get_usage. */
function scriptedClaude(): FakeLineProcess {
  const fake = fakeLineProcess((text, child) => {
    const request = asRecord(JSON.parse(text));
    const subtype = asRecord(request?.request)?.subtype;
    if (subtype === "initialize") {
      child.emit(line({ type: "control_response", response: { subtype: "success", request_id: request?.request_id, response: {} } }));
    } else if (subtype === "get_usage") {
      child.emit(line({ type: "control_response", response: { subtype: "success", request_id: request?.request_id, response: { session: { model_usage: {} } } } }));
    }
  });
  spawnLineProcess.mockReturnValue(fake);
  return fake;
}

const argv = (): readonly string[] => spawnLineProcess.mock.calls[0]?.[1] ?? [];

const linkedEvents = (session: Awaited<ReturnType<typeof claudeSession>>): unknown[] =>
  session.records().flatMap((record) => record.kind === "frame" ? record.body.events.filter((event) => event.kind === "session_linked") : []);

test("a fork resumes the source under a new session id and records its lineage on the first root frame", async () => {
  const fake = scriptedClaude();
  const session = await claudeSession(installation, { cwd: "/work", forkFrom: { sessionId: parent } });
  try {
    expect(argv()).toEqual(expect.arrayContaining(["--resume", parent, "--fork-session", "--session-id", session.id]));
    expect(session.id).not.toBe(parent);
    fake.emit(line({ type: "system", subtype: "init", session_id: session.id }));
    await vi.waitFor(() => {
      expect(session.graph().edges).toEqual([{ parent, child: session.id, via: "fork" }]);
    });
    expect(linkedEvents(session)).toEqual([{ kind: "session_linked", parent, child: session.id, via: "fork" }]);
  } finally { await session.dispose(); }
});

test("fork and resume are mutually exclusive, before anything starts", async () => {
  await expect(claudeSession(installation, {
    cwd: "/work",
    resume: "old-id",
    forkFrom: { sessionId: parent },
  })).rejects.toMatchObject({ name: "UnsupportedOptionError", option: "forkFrom", message: "forkFrom and resume are mutually exclusive" });
  expect(spawnLineProcess).not.toHaveBeenCalled();
});

test("claude forks the whole saved conversation, so forkFrom.through is refused rather than dropped", async () => {
  const opening = claudeSession(installation, { cwd: "/work", forkFrom: { sessionId: parent, through: "leaf-1" } });
  await expect(opening).rejects.toBeInstanceOf(UnsupportedOptionError);
  await expect(opening).rejects.toMatchObject({ option: "forkFrom", message: "claude forks the whole saved conversation; forkFrom.through is not supported" });
  expect(spawnLineProcess).not.toHaveBeenCalled();
});
