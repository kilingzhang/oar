import { claudeCompaction, CLAUDE_COMPACTION_BUSY } from "./compaction.js";
import { randomUUID } from "node:crypto";
import type { StartSession } from "../../contracts/session.js";
import { UnsupportedOptionError } from "../../contracts/errors.js";
import { withSessionCredentials } from "../../shared/session-credentials.js";
import { streamJsonSession } from "../../shared/stream-json/session.js";
import { claudeOpenSettings } from "./open-settings.js";
import { claudeContextBreakdownReader } from "./context-breakdown.js";
import { launchClaude } from "./launch.js";
import { claudeProjectionProfile, claudeUsageBaselined, initialClaudeProjection, resumedClaudeProjection } from "./projection.js";

/** Claude owns launch flags, private account/settings readbacks and usage baselines. */
export const claudeSession: StartSession = withSessionCredentials(async (installation, options, credentials) => {
  if (installation.via !== "executable") {
    throw new Error("The claude session adapter needs an executable installation");
  }
  if (options.resume !== undefined && options.forkFrom !== undefined) {
    throw new UnsupportedOptionError("forkFrom", "forkFrom and resume are mutually exclusive");
  }
  if (options.forkFrom?.through !== undefined) {
    throw new UnsupportedOptionError("forkFrom", "claude forks the whole saved conversation; forkFrom.through is not supported");
  }
  // A fork is a new native id whose history comes from the source; usage and
  // copied history read back like a resume.
  const reopened = options.resume !== undefined || options.forkFrom !== undefined;
  const sessionId = options.resume ?? randomUUID();
  const child = await launchClaude(installation.command, sessionId, options);
  const readback = claudeOpenSettings(child);
  const contextBreakdown = claudeContextBreakdownReader(child);
  const compaction = claudeCompaction(child);
  return streamJsonSession(child, sessionId, credentials, {
    projection: claudeProjectionProfile,
    ...(options.forkFrom === undefined ? {} : {
      openLinks: [{ parent: options.forkFrom.sessionId, child: sessionId, via: "fork" as const }],
    }),
    initial: reopened ? resumedClaudeProjection : initialClaudeProjection,
    capabilities: { queue: { durable: false }, attribution: "attributed", images: true },
    steer: true,
    stopTask: (taskId) => ({ subtype: "stop_task", task_id: taskId }),
    compaction: { busyReason: CLAUDE_COMPACTION_BUSY, create: compaction.create },
    cancelQueuedCapability: "interrupt_cancel_queued_v1",
    consume: (message) => readback.consume(message) || contextBreakdown.consume(message) || compaction.consume(message),
    open: async (projection) => {
      await readback.confirm(options);
      if (reopened) {
        projection.replace(claudeUsageBaselined(projection.current(), await readback.usageBaseline()));
      }
    },
    exited: (code) => { readback.exited(code); contextBreakdown.exited(); compaction.close(); },
    disposing: () => { contextBreakdown.exited(); compaction.close(); },
    contextBreakdown: contextBreakdown.read,
    // Preserve Claude's existing behavior: permissions are recorded, not answered.
  });
});
