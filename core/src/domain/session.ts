import type { SessionId, SessionMode } from './ids.js';

export type SessionPhase =
  | 'PREFLIGHT'
  | 'OPEN'
  | 'ENTRY_CUTOFF'
  | 'SQUARE_OFF'
  | 'HALTED'
  | 'KILLED'
  | 'CLOSED';

export interface SessionState {
  sessionId: SessionId;
  mode: SessionMode;
  /** Trading date YYYY-MM-DD (IST). */
  date: string;
  phase: SessionPhase;
  /** Config name → content hash, journaled at start. */
  configHashes: Record<string, string>;
  startedTs: number;
}

/**
 * One named preflight/self-test check result. Structurally identical to the
 * kill switch's `SelfTestCheck` so the two can be folded into one checklist.
 */
export interface PreflightCheck {
  name: string;
  ok: boolean;
  detail?: string;
}
