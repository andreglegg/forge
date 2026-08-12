/**
 * The event contract: what a client reading Forge's stream is promised.
 *
 * `--stream-json` is already the surface an editor plug-in, a bridge, or a CI
 * job would build on, and until now it was an undocumented shape that could
 * change under them without a word. A client that cannot tell which contract it
 * is reading has two bad options: guess, or re-verify every field on every
 * event. This module gives it a third -- read the first line.
 *
 * Versioning is major.minor with the usual meaning, stated here because the
 * whole point is that both sides agree on it:
 *
 * - **minor** goes up for additive change: a new event type, a new optional
 *   field. A client written for an older minor stays correct, because the rule
 *   below is that unknown event types are skipped, not fatal.
 * - **major** goes up for anything a client could misread: a removed or renamed
 *   event, a field whose meaning changes, a different envelope. A client must
 *   refuse a major it does not implement rather than interpret it.
 *
 * `EVENT_TYPES` is the enumeration a client validates against, and it is kept
 * honest by a test that reads the `RunEvent` union in `runtime.ts`: adding an
 * event without registering it here fails the suite. That is the mechanism --
 * the promise is not a comment, it is checked.
 */

import { FORGE_VERSION } from "./version.js";

export const EVENT_CONTRACT_VERSION = "1.1";

/**
 * Every event type that can appear in the stream or a session journal.
 *
 * Order is the union's own, not alphabetical, so a diff against `runtime.ts`
 * reads straight down.
 */
export const EVENT_TYPES = [
  "run.started",
  "turn.started",
  "model.delta",
  "model.text",
  "action.proposed",
  "approval.requested",
  "approval.resolved",
  "action.started",
  "action.finished",
  "mutation.committed",
  "run.finished",
  "run.reopened",
  "verification.started",
  "verification.finished",
  "run.failed",
  "run.cancelled",
  // 1.1: compaction telemetry. Emitted before its turn's `turn.started`,
  // because the transcript is bounded while the request is assembled.
  "context.compacted",
] as const;

/** The envelopes that carry those events on the wire. */
export const ENVELOPE_TYPES = ["contract", "event", "result", "error"] as const;

export interface ContractHeader {
  readonly type: "contract";
  readonly contract: {
    readonly version: string;
    readonly forge: string;
    readonly envelopes: readonly string[];
    readonly events: readonly string[];
  };
}

/** The first line of a `--stream-json` run, and what `forge contract` prints. */
export function contractHeader(): ContractHeader {
  return {
    type: "contract",
    contract: {
      version: EVENT_CONTRACT_VERSION,
      forge: FORGE_VERSION,
      envelopes: [...ENVELOPE_TYPES],
      events: [...EVENT_TYPES],
    },
  };
}

export interface ContractCompatibility {
  readonly ok: boolean;
  /** True when the stream may carry events the client's version did not define. */
  readonly degraded: boolean;
  readonly reason: string;
}

function parseVersion(version: string): { major: number; minor: number } | null {
  const match = /^(\d+)\.(\d+)$/.exec(version.trim());
  if (match === null) return null;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

/**
 * Whether a client written for `clientVersion` may read this build's stream.
 *
 * Deliberately not symmetric. A client older by a minor is *degraded but ok*:
 * it will meet event types it does not know and must skip them. A client newer
 * by a minor is fine -- it knows more than it will see. A different major is
 * never ok, in either direction, because the failure mode of guessing is a
 * client that quietly acts on a field that no longer means what it thinks.
 */
export function checkContract(
  clientVersion: string,
  streamVersion: string = EVENT_CONTRACT_VERSION,
): ContractCompatibility {
  const client = parseVersion(clientVersion);
  const stream = parseVersion(streamVersion);
  if (client === null) {
    return { ok: false, degraded: false, reason: `unreadable contract version: ${clientVersion}` };
  }
  if (stream === null) {
    return { ok: false, degraded: false, reason: `unreadable contract version: ${streamVersion}` };
  }
  if (client.major !== stream.major) {
    return {
      ok: false,
      degraded: false,
      reason: `incompatible event contract: client speaks ${clientVersion}, stream speaks ${streamVersion}`,
    };
  }
  if (client.minor < stream.minor) {
    return {
      ok: true,
      degraded: true,
      reason: `stream ${streamVersion} is newer than client ${clientVersion}; unknown event types must be skipped`,
    };
  }
  return {
    ok: true,
    degraded: false,
    reason: `client ${clientVersion} reads stream ${streamVersion}`,
  };
}
