import { afterEach, expect, test, vi } from "vitest";
import { UnsupportedOptionError } from "../../packages/oar/src/contracts/errors.js";
import { SessionNotFoundError } from "../../packages/oar/src/contracts/session-not-found-error.js";
import { codexSession } from "../../packages/oar/src/runtimes/codex/session.js";
import { asRecord, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { fakeLineProcess, type FakeLineProcess } from "../fixtures/fake-line-process.js";

const spawnLineProcess = vi.hoisted(() => vi.fn<(command: string, args: readonly string[]) => FakeLineProcess>());
vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));
const installation = { kind: "available", via: "executable", command: "codex", version: "0.165.0" } as const;
const parent = "thread-parent";
const forked = "thread-fork";

afterEach(() => { spawnLineProcess.mockReset(); });

const line = (value: Record<string, unknown>): string => `${JSON.stringify(value)}\n`;

interface Scripted { readonly fake: FakeLineProcess; readonly requests: JsonRecord[] }

/**
 * A scripted app-server: initialize and thread/fork answer, or `forkError`
 * answers thread/fork with codex's own -32600 refusal.
 */
function scriptedAppServer(options: { forkError?: string; forkedFromId?: string } = {}): Scripted {
  const requests: JsonRecord[] = [];
  let ended = false;
  const fake = fakeLineProcess((text, child) => {
    const message = asRecord(JSON.parse(text));
    if (ended || typeof message?.id !== "number" || typeof message.method !== "string") { return; }
    requests.push(message);
    if (message.method === "thread/fork" && options.forkError !== undefined) {
      child.emit(line({ id: message.id, error: { code: -32_600, message: options.forkError } }));
      return;
    }
    const result = message.method === "thread/fork"
      ? { thread: { id: forked, ...(options.forkedFromId === undefined ? {} : { forkedFromId: options.forkedFromId }) }, model: "gpt-5.5" }
      : {};
    child.emit(line({ id: message.id, result }));
  });
  fake.onExit(() => { ended = true; });
  spawnLineProcess.mockReturnValue(fake);
  return { fake, requests };
}

const requestOf = (requests: readonly JsonRecord[], method: string): JsonRecord | undefined =>
  requests.find((request) => request.method === method);

const linkedEvents = (session: Awaited<ReturnType<typeof codexSession>>): unknown[] =>
  session.records().flatMap((record) => record.kind === "frame" ? record.body.events.filter((event) => event.kind === "session_linked") : []);

test("a fork asks codex for thread/fork and records the forkedFromId lineage codex reports", async () => {
  const { requests } = scriptedAppServer({ forkedFromId: parent });
  const session = await codexSession(installation, { cwd: "/work", forkFrom: { sessionId: parent } });
  try {
    expect(requestOf(requests, "thread/fork")?.params).toMatchObject({
      threadId: parent,
      excludeTurns: true,
      cwd: "/work",
      approvalPolicy: "never",
    });
    expect(requestOf(requests, "thread/fork")?.params).not.toHaveProperty("lastTurnId");
    expect(session.id).toBe(forked);
    expect(session.graph().edges).toEqual([{ parent, child: forked, via: "fork" }]);
    expect(linkedEvents(session)).toEqual([{ kind: "session_linked", parent, child: forked, via: "fork" }]);
  } finally { await session.dispose(); }
});

test("forkFrom.through becomes codex's lastTurnId, which forks the tail of the saved thread", async () => {
  const { requests } = scriptedAppServer({ forkedFromId: parent });
  const session = await codexSession(installation, { cwd: "/work", forkFrom: { sessionId: parent, through: "turn-7" } });
  try {
    expect(requestOf(requests, "thread/fork")?.params).toMatchObject({ threadId: parent, lastTurnId: "turn-7", excludeTurns: true });
  } finally { await session.dispose(); }
});

test("a reply without forkedFromId records no lineage rather than inventing one from the request", async () => {
  scriptedAppServer();
  const session = await codexSession(installation, { cwd: "/work", forkFrom: { sessionId: parent } });
  try {
    expect(session.id).toBe(forked);
    expect(session.graph().edges).toEqual([]);
    expect(linkedEvents(session)).toEqual([]);
  } finally { await session.dispose(); }
});

test("a missing fork source is a SessionNotFoundError named after thread/fork", async () => {
  scriptedAppServer({ forkError: `no rollout found for thread id ${parent}` });
  const failure: unknown = await codexSession(installation, { cwd: "/work", forkFrom: { sessionId: parent } }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(SessionNotFoundError);
  expect(failure).toMatchObject({ sessionId: parent, cause: { method: "thread/fork", native: { code: -32_600 } } });
});

test("fork and resume are mutually exclusive, before codex starts", async () => {
  const opening = codexSession(installation, { cwd: "/work", resume: "saved", forkFrom: { sessionId: parent } });
  await expect(opening).rejects.toBeInstanceOf(UnsupportedOptionError);
  await expect(opening).rejects.toMatchObject({ option: "forkFrom", message: "forkFrom and resume are mutually exclusive" });
  expect(spawnLineProcess).not.toHaveBeenCalled();
});
