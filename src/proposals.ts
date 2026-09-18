import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";
import { dataPath } from "./state.js";
import { localDate } from "./daily-review.js";
import { startPoller } from "./poller.js";

export type ProposalKind = "email_draft" | "email_fyi" | "email_decision" | "calendar_move" | "history_import";
export type ProposalStatus = "proposed" | "approved" | "executing" | "completed" | "partially_completed" | "rejected" | "ignored" | "deferred" | "expired" | "invalidated" | "failed";

export interface ProposalInput {
  ownerSpaceId: string;
  kind: ProposalKind;
  summary: string;
  detail: string;
  payload: unknown;
  sourceKey?: string;
  evidence: { sourceType: string; sourceId?: string; contact?: string; senderName?: string; category?: string; ruleIds?: string[]; rationale: string; confidence: number; priority?: "high" | "normal" | "low"; deadlineAt?: string; sourceReceivedAt?: string };
  expiresAt: string;
}

export interface Proposal extends ProposalInput {
  id: string;
  status: ProposalStatus;
  createdAt: string;
  approvedAt?: string;
  completedAt?: string;
  outcome?: string;
  deferredUntil?: string;
  payloadHash: string;
  /** Captured when the owner's approval command is resolved, never inferred by the model. */
  reviewedBriefingId?: string;
  reviewedPayloadHash?: string;
  ownerFeedback?: string;
  preferenceKey?: string;
  lastNotifiedAt?: string;
}

export type BriefingDeliveryStatus = "pending" | "delivery_unknown" | "delivered";

export interface BriefingDelivery {
  id: string;
  reviewKey: string;
  ownerSpaceId: string;
  proposalIds: string[];
  status: BriefingDeliveryStatus;
  createdAt: string;
  deliveredAt?: string;
  attempts: number;
  deliveredText?: string;
}

export interface PreferenceRule {
  key: string;
  value: string;
  confidence: number;
  evidenceCount: number;
  updatedAt: string;
  expiresAt?: string;
  reviewAfter?: string;
}

export type ProposalCommand =
  | { type: "approve"; proposal: Proposal }
  | { type: "reject"; proposal: Proposal; disposition: "rejected" | "ignored" | "not_important" }
  | { type: "defer"; proposal: Proposal; until: string }
  | { type: "explain"; proposal: Proposal }
  | { type: "show"; proposal: Proposal }
  | { type: "done"; proposal: Proposal }
  | { type: "always_surface"; proposal: Proposal };

function resolveDeferDate(value: string, now: Date, timezone: string): string | undefined {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const today = localDate(now.getTime(), timezone);
  const base = new Date(`${today}T12:00:00Z`);
  const normalized = value.trim().toLowerCase();
  if (normalized === "today") return today;
  if (normalized === "tomorrow") { base.setUTCDate(base.getUTCDate() + 1); return base.toISOString().slice(0, 10); }
  const weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const target = weekdays.indexOf(normalized);
  if (target < 0) return undefined;
  const delta = (target - base.getUTCDay() + 7) % 7 || 7;
  base.setUTCDate(base.getUTCDate() + delta);
  return base.toISOString().slice(0, 10);
}

/**
 * Durable approval state is deliberately separate from model transcripts. The
 * iMessage command parser can therefore resolve a numbered proposal without
 * relying on a hosted conversation or model memory.
 */
export class ProposalLedger {
  private readonly db: DatabaseSync;

  constructor(filename = dataPath("chief-of-staff.sqlite")) {
    mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    const version = Number((this.db.prepare("PRAGMA user_version").get() as { user_version?: number }).user_version ?? 0);
    if (version > 4) {
      this.db.close();
      throw new Error(`Chief-of-staff data version ${version} is newer than this Pingu supports.`);
    }
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS proposals (
        id TEXT PRIMARY KEY,
        owner_space_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        summary TEXT NOT NULL,
        detail TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        payload_hash TEXT,
        source_key TEXT,
        evidence_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        approved_at TEXT,
        completed_at TEXT,
        outcome TEXT,
        deferred_until TEXT,
        owner_feedback TEXT,
        preference_key TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS proposals_owner_status ON proposals(owner_space_id, status);
      CREATE INDEX IF NOT EXISTS proposals_source ON proposals(owner_space_id, kind, source_key);
      CREATE TABLE IF NOT EXISTS briefings (
        id TEXT PRIMARY KEY,
        review_key TEXT NOT NULL UNIQUE,
        owner_space_id TEXT NOT NULL,
        proposal_ids_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        delivered_at TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        superseded_at TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS preferences (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        confidence REAL NOT NULL,
        evidence_count INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT,
        review_after TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS action_claims (
        action_key TEXT PRIMARY KEY,
        proposal_id TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `);
    const columns = this.db.prepare("PRAGMA table_info(proposals)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "deferred_until")) this.db.exec("ALTER TABLE proposals ADD COLUMN deferred_until TEXT");
    if (!columns.some((column) => column.name === "payload_hash")) this.db.exec("ALTER TABLE proposals ADD COLUMN payload_hash TEXT");
    if (!columns.some((column) => column.name === "owner_feedback")) this.db.exec("ALTER TABLE proposals ADD COLUMN owner_feedback TEXT");
    if (!columns.some((column) => column.name === "preference_key")) this.db.exec("ALTER TABLE proposals ADD COLUMN preference_key TEXT");
    const preferenceColumns = this.db.prepare("PRAGMA table_info(preferences)").all() as Array<{ name: string }>;
    if (!preferenceColumns.some((column) => column.name === "expires_at")) this.db.exec("ALTER TABLE preferences ADD COLUMN expires_at TEXT");
    if (!preferenceColumns.some((column) => column.name === "review_after")) this.db.exec("ALTER TABLE preferences ADD COLUMN review_after TEXT");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!columns.some((column) => column.name === "last_notified_at")) {
        this.db.exec("ALTER TABLE proposals ADD COLUMN last_notified_at TEXT");
        // Preserve what the owner has already seen, including superseded briefings.
        this.db.exec(`UPDATE proposals SET last_notified_at = (
          SELECT MAX(b.delivered_at) FROM briefings b, json_each(b.proposal_ids_json) item
          WHERE b.status = 'delivered' AND item.value = proposals.id AND b.owner_space_id = proposals.owner_space_id
        )`);
      }
      const briefingColumns = this.db.prepare("PRAGMA table_info(briefings)").all() as Array<{ name: string }>;
      if (!briefingColumns.some((column) => column.name === "delivered_text")) this.db.exec("ALTER TABLE briefings ADD COLUMN delivered_text TEXT");
      if (!briefingColumns.some((column) => column.name === "proposal_hashes_json")) this.db.exec("ALTER TABLE briefings ADD COLUMN proposal_hashes_json TEXT");
      // Legacy briefings have no provable reviewed version. Never backfill from today's payload.
      this.db.exec("PRAGMA user_version = 4; COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void { this.db.close(); }

  /**
   * Before email outcomes existed, every actionable email was stored as an
   * email-reply proposal. Those rows can turn a FYI or calendar invite into a
   * misleading Gmail-draft approval after an upgrade. They have never created
   * a draft, so invalidate them rather than silently carrying old judgement
   * forward. New rows use email-draft, email-fyi, or email-decision instead.
   */
  invalidateLegacyEmailReplyProposals(now = new Date()): number {
    const rows = this.db.prepare("SELECT id, evidence_json FROM proposals WHERE kind = 'email_draft' AND status IN ('proposed','deferred')").all() as Array<{ id: string; evidence_json: string }>;
    const ids = rows.flatMap((row) => {
      try { return (JSON.parse(row.evidence_json) as { category?: unknown }).category === "email-reply" ? [row.id] : []; } catch { return []; }
    });
    if (ids.length === 0) return 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const statement = this.db.prepare("UPDATE proposals SET status = 'invalidated', completed_at = ?, outcome = ? WHERE id = ? AND status IN ('proposed','deferred')");
      for (const id of ids) statement.run(now.toISOString(), "Replaced by Pingu's newer email classification. Review the source message again if action is still needed.", id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return ids.length;
  }

  create(input: ProposalInput, now = new Date()): Proposal {
    if (input.sourceKey) {
      const existing = this.db.prepare("SELECT id FROM proposals WHERE owner_space_id = ? AND kind = ? AND source_key = ? ORDER BY created_at DESC LIMIT 1").get(input.ownerSpaceId, input.kind, input.sourceKey) as { id?: string } | undefined;
      if (existing?.id) {
        const current = this.get(existing.id)!;
        const retryable = current.status === "failed" || current.status === "invalidated" || current.status === "expired";
        if ((!input.evidence.sourceId || current.evidence.sourceId === input.evidence.sourceId) && !retryable) return current;
        if (["proposed", "approved", "deferred"].includes(current.status)) this.db.prepare("UPDATE proposals SET status = 'invalidated', outcome = ?, completed_at = ? WHERE id = ?").run("The source changed before approval.", now.toISOString(), current.id);
      }
    }
    const payloadJson = JSON.stringify(input.payload);
    const proposal: Proposal = { ...input, id: randomUUID(), status: "proposed", createdAt: now.toISOString(), payloadHash: createHash("sha256").update(payloadJson).digest("hex") };
    this.db.prepare(`INSERT INTO proposals (id, owner_space_id, kind, summary, detail, payload_json, payload_hash, source_key, evidence_json, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      proposal.id, proposal.ownerSpaceId, proposal.kind, proposal.summary, proposal.detail,
      payloadJson, proposal.payloadHash, proposal.sourceKey ?? null, JSON.stringify(proposal.evidence), proposal.status,
      proposal.createdAt, proposal.expiresAt,
    );
    return proposal;
  }

  bindBriefing(ownerSpaceId: string, proposalIds: readonly string[], now = new Date(), reviewKey = `${ownerSpaceId}:${now.toISOString()}:${randomUUID()}`): BriefingDelivery {
    const existing = this.briefing(reviewKey);
    if (existing) return existing;
    const briefingId = randomUUID();
    this.db.prepare("INSERT INTO briefings (id, review_key, owner_space_id, proposal_ids_json, proposal_hashes_json, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)").run(briefingId, reviewKey, ownerSpaceId, JSON.stringify(proposalIds), this.snapshotHashes(ownerSpaceId, proposalIds), now.toISOString());
    return this.briefing(reviewKey)!;
  }

  briefing(reviewKey: string): BriefingDelivery | undefined {
    const row = this.db.prepare("SELECT * FROM briefings WHERE review_key = ?").get(reviewKey) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return { id: String(row.id), reviewKey: String(row.review_key), ownerSpaceId: String(row.owner_space_id), proposalIds: JSON.parse(String(row.proposal_ids_json)), status: row.status as BriefingDeliveryStatus, createdAt: String(row.created_at), attempts: Number(row.attempts), ...(typeof row.delivered_at === "string" ? { deliveredAt: row.delivered_at } : {}), ...(typeof row.delivered_text === "string" ? { deliveredText: row.delivered_text } : {}) };
  }

  markBriefingAttempt(reviewKey: string, text?: string): boolean {
    // Claim once, before sending. Unknown delivery is held for reconciliation, never replayed.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const claimed = Number(this.db.prepare("UPDATE briefings SET status = 'delivery_unknown', attempts = attempts + 1, delivered_text = COALESCE(?, delivered_text) WHERE review_key = ? AND status = 'pending'").run(text ?? null, reviewKey).changes) === 1;
      if (claimed) {
        const briefing = this.briefing(reviewKey)!;
        // The new message may already be visible. Old ordinals are no longer safe to approve.
        this.db.prepare("UPDATE briefings SET superseded_at = ? WHERE owner_space_id = ? AND id != ? AND status IN ('delivered','delivery_unknown') AND superseded_at IS NULL").run(new Date().toISOString(), briefing.ownerSpaceId, briefing.id);
      }
      this.db.exec("COMMIT");
      return claimed;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  refreshPendingBriefing(reviewKey: string, ids: string[]): void {
    const briefing = this.briefing(reviewKey);
    if (!briefing) return;
    this.db.prepare("UPDATE briefings SET proposal_ids_json = ?, proposal_hashes_json = ? WHERE review_key = ? AND status = 'pending' AND attempts = 0").run(JSON.stringify(ids), this.snapshotHashes(briefing.ownerSpaceId, ids), reviewKey);
  }

  private snapshotHashes(ownerSpaceId: string, ids: readonly string[]): string {
    return JSON.stringify(Object.fromEntries(this.proposalsById(ids).filter((p) => p.ownerSpaceId === ownerSpaceId).map((p) => [p.id, p.payloadHash])));
  }

  hasUnconfirmedBriefing(ownerSpaceId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM briefings WHERE owner_space_id = ? AND status = 'delivery_unknown' AND superseded_at IS NULL LIMIT 1").get(ownerSpaceId));
  }

  markBriefingDelivered(reviewKey: string, now = new Date(), text?: string): void {
    const briefing = this.briefing(reviewKey);
    if (!briefing) throw new Error("The briefing no longer exists.");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (briefing.proposalIds.length) {
        this.db.prepare("UPDATE briefings SET superseded_at = ? WHERE owner_space_id = ? AND id != ? AND status = 'delivered' AND superseded_at IS NULL").run(now.toISOString(), briefing.ownerSpaceId, briefing.id);
      }
      // Empty reviews are completed silently, never becoming the visible command target.
      this.db.prepare("UPDATE briefings SET status = 'delivered', delivered_at = ?, superseded_at = ?, delivered_text = COALESCE(?, delivered_text) WHERE review_key = ?").run(now.toISOString(), briefing.proposalIds.length ? null : now.toISOString(), text ?? null, reviewKey);
      const notified = this.db.prepare("UPDATE proposals SET last_notified_at = ? WHERE id = ? AND owner_space_id = ?");
      for (const id of briefing.proposalIds) notified.run(now.toISOString(), id, briefing.ownerSpaceId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listOpen(ownerSpaceId: string, now = new Date(), limit = 5, timezone = "UTC"): Proposal[] {
    this.db.prepare("UPDATE proposals SET status = 'proposed', last_notified_at = NULL WHERE owner_space_id = ? AND status = 'deferred' AND deferred_until <= ? AND expires_at > ?").run(ownerSpaceId, localDate(now.getTime(), timezone), now.toISOString());
    this.db.prepare("UPDATE proposals SET status = 'expired' WHERE owner_space_id = ? AND status IN ('proposed','deferred') AND expires_at <= ?").run(ownerSpaceId, now.toISOString());
    const rows = this.db.prepare("SELECT id FROM proposals WHERE owner_space_id = ? AND status = 'proposed' ORDER BY created_at ASC LIMIT ?").all(ownerSpaceId, limit) as Array<{ id: string }>;
    return rows.map(({ id }) => this.get(id)!).filter(Boolean);
  }

  currentBriefingProposals(ownerSpaceId: string): Proposal[] {
    const briefing = this.db.prepare("SELECT proposal_ids_json FROM briefings WHERE owner_space_id = ? AND status = 'delivered' AND superseded_at IS NULL ORDER BY delivered_at DESC LIMIT 1").get(ownerSpaceId) as { proposal_ids_json?: string } | undefined;
    if (!briefing?.proposal_ids_json) return [];
    return (JSON.parse(briefing.proposal_ids_json) as string[]).map((id) => this.get(id)).filter((proposal): proposal is Proposal => Boolean(proposal));
  }

  /** Fresh items first; an existing item returns only when its deadline newly enters the next 24 hours. */
  briefingCandidates(ownerSpaceId: string, now = new Date(), limit = 3, timezone = "UTC"): Proposal[] {
    const deadline = (proposal: Proposal) => Date.parse(proposal.evidence.deadlineAt ?? "");
    const due = (proposal: Proposal) => Number.isFinite(deadline(proposal)) && deadline(proposal) <= now.getTime() + 86_400_000;
    const importance = (proposal: Proposal) => ({ high: 2, normal: 1, low: 0 })[proposal.evidence.priority ?? "normal"];
    const action = (proposal: Proposal) => proposal.kind === "email_fyi" ? 0 : 1;
    return this.listOpen(ownerSpaceId, now, -1, timezone)
      .filter((proposal) => !this.db.prepare("SELECT 1 FROM briefings b, json_each(b.proposal_ids_json) item WHERE b.status = 'delivery_unknown' AND b.owner_space_id = ? AND item.value = ? LIMIT 1").get(ownerSpaceId, proposal.id))
      .filter((proposal) => !proposal.lastNotifiedAt || (due(proposal) && deadline(proposal) > Date.parse(proposal.lastNotifiedAt) + 86_400_000))
      .sort((a, b) => Number(due(b)) - Number(due(a)) || importance(b) - importance(a) || action(b) - action(a)
        || (Number.isFinite(deadline(a)) ? deadline(a) : Infinity) - (Number.isFinite(deadline(b)) ? deadline(b) : Infinity)
        || a.createdAt.localeCompare(b.createdAt))
      .slice(0, limit);
  }

  invalidateUnresolved(id: string, reason: string, now = new Date()): void {
    this.db.prepare("UPDATE proposals SET status = 'invalidated', completed_at = ?, outcome = ? WHERE id = ? AND status IN ('proposed','deferred')").run(now.toISOString(), reason, id);
  }

  recordSourceReceipt(id: string, receivedAt: string): void {
    this.db.prepare("UPDATE proposals SET evidence_json = json_set(evidence_json, '$.sourceReceivedAt', ?) WHERE id = ?").run(receivedAt, id);
  }

  /** Exact visible message plus current state; caller must enforce owner-DM access. */
  briefingContext(ownerSpaceId: string): string | undefined {
    const row = this.db.prepare("SELECT review_key FROM briefings WHERE owner_space_id = ? AND status = 'delivered' AND superseded_at IS NULL ORDER BY delivered_at DESC LIMIT 1").get(ownerSpaceId) as { review_key?: string } | undefined;
    const briefing = row?.review_key ? this.briefing(row.review_key) : undefined;
    if (!briefing) return undefined;
    return JSON.stringify({ deliveredAt: briefing.deliveredAt, text: briefing.deliveredText,
      items: this.proposalsById(briefing.proposalIds).map((proposal, index) => ({ number: index + 1, kind: proposal.kind, summary: proposal.summary.slice(0, 500), rationale: proposal.evidence.rationale.slice(0, 500), status: proposal.status, expiresAt: proposal.expiresAt })) });
  }

  proposalsById(ids: readonly string[]): Proposal[] {
    return ids.map((id) => this.get(id)).filter((proposal): proposal is Proposal => Boolean(proposal));
  }

  findSourceVersion(ownerSpaceId: string, kind: ProposalKind, sourceKey: string, sourceId: string): Proposal | undefined {
    const rows = this.db.prepare("SELECT id, evidence_json FROM proposals WHERE owner_space_id = ? AND kind = ? AND source_key = ? ORDER BY created_at DESC").all(ownerSpaceId, kind, sourceKey) as Array<{ id: string; evidence_json: string }>;
    const match = rows.find((row) => (JSON.parse(row.evidence_json) as { sourceId?: string }).sourceId === sourceId);
    return match ? this.get(match.id) : undefined;
  }

  claimExecution(id: string, now = new Date(), expected?: { briefingId?: string; payloadHash?: string }): Proposal | undefined {
    // The source version, not model wording, identifies one external action.
    // Two owner chats may hold differently edited copies of the same proposal;
    // only the first approval may act. A later Gmail message has a new sourceId
    // and can therefore produce a fresh reply in the same thread.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const proposal = this.get(id);
      if (!proposal || !["proposed", "approved"].includes(proposal.status) || Date.parse(proposal.expiresAt) <= now.getTime()) { this.db.exec("COMMIT"); return undefined; }
      const briefing = this.db.prepare("SELECT id, proposal_hashes_json FROM briefings WHERE owner_space_id = ? AND status = 'delivered' AND superseded_at IS NULL ORDER BY delivered_at DESC LIMIT 1").get(proposal.ownerSpaceId) as { id: string; proposal_hashes_json?: string } | undefined;
      const reviewedHash = briefing?.proposal_hashes_json ? (JSON.parse(briefing.proposal_hashes_json) as Record<string, string>)[id] : undefined;
      if (this.hasUnconfirmedBriefing(proposal.ownerSpaceId) || !reviewedHash || (expected && (expected.briefingId !== briefing?.id || expected.payloadHash !== reviewedHash)) || reviewedHash !== proposal.payloadHash || reviewedHash !== createHash("sha256").update(JSON.stringify(proposal.payload)).digest("hex")) {
        this.db.exec("COMMIT");
        return undefined;
      }
      const actionKey = `${proposal.kind}:${proposal.sourceKey ?? proposal.id}:${proposal.evidence.sourceId ?? proposal.id}`;
      const claim = this.db.prepare("INSERT INTO action_claims VALUES (?, ?, 'executing', ?) ON CONFLICT(action_key) DO UPDATE SET proposal_id = excluded.proposal_id, status = 'executing', updated_at = excluded.updated_at WHERE action_claims.status IN ('failed','invalidated')").run(actionKey, id, now.toISOString());
      if (Number(claim.changes) !== 1) {
        this.db.prepare("UPDATE proposals SET status = 'invalidated', completed_at = ?, outcome = ? WHERE id = ? AND status IN ('proposed','approved')").run(now.toISOString(), "The same action was already claimed from another owner chat.", id);
        this.db.exec("COMMIT");
        return undefined;
      }
      const result = this.db.prepare("UPDATE proposals SET status = 'executing', approved_at = COALESCE(approved_at, ?) WHERE id = ? AND status IN ('proposed','approved')").run(now.toISOString(), id);
      if (Number(result.changes) !== 1) throw new Error("The proposal changed while execution was claimed.");
      this.db.exec("COMMIT");
      return this.get(id);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  settle(id: string, status: Extract<ProposalStatus, "completed" | "partially_completed" | "failed" | "invalidated">, outcome: string, now = new Date()): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db.prepare("UPDATE proposals SET status = ?, outcome = ?, completed_at = ? WHERE id = ? AND status = 'executing'").run(status, outcome, now.toISOString(), id);
      if (Number(result.changes) === 1) this.db.prepare("UPDATE action_claims SET status = ?, updated_at = ? WHERE proposal_id = ?").run(status, now.toISOString(), id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  uncertainActions(limit = 10): Proposal[] {
    const rows = this.db.prepare("SELECT id FROM proposals WHERE status = 'partially_completed' AND kind IN ('email_draft','calendar_move') ORDER BY COALESCE((SELECT value FROM metadata WHERE key = 'reconcile:' || proposals.id), '') ASC LIMIT ?").all(limit) as Array<{ id: string }>;
    return this.proposalsById(rows.map((row) => row.id));
  }

  completeReconciled(id: string, outcome: string, now = new Date()): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db.prepare("UPDATE proposals SET status = 'completed', outcome = ?, completed_at = ? WHERE id = ? AND status = 'partially_completed'").run(outcome, now.toISOString(), id);
      if (Number(result.changes) === 1) this.db.prepare("UPDATE action_claims SET status = 'completed', updated_at = ? WHERE proposal_id = ? AND status = 'partially_completed'").run(now.toISOString(), id);
      this.db.exec("COMMIT");
      return Number(result.changes) === 1;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  invalidateOwnerSpace(ownerSpaceId: string, now = new Date()): number {
    return Number(this.db.prepare("UPDATE proposals SET status = 'invalidated', completed_at = ?, outcome = ? WHERE owner_space_id = ? AND status IN ('proposed','approved','deferred')").run(now.toISOString(), "The owner chat was revoked.", ownerSpaceId).changes);
  }

  interruptedExecutions(before: Date): Proposal[] {
    const rows = this.db.prepare("SELECT p.id FROM proposals p JOIN action_claims a ON a.proposal_id = p.id WHERE p.status = 'executing' AND a.status = 'executing' AND a.updated_at < ? ORDER BY a.updated_at ASC").all(before.toISOString()) as Array<{ id: string }>;
    return rows.map(({ id }) => this.get(id)).filter((proposal): proposal is Proposal => Boolean(proposal));
  }

  recordFeedback(id: string, feedback: string): void {
    this.db.prepare("UPDATE proposals SET owner_feedback = ? WHERE id = ?").run(feedback.slice(0, 1_000), id);
  }

  linkPreference(id: string, preferenceKey: string): void {
    this.db.prepare("UPDATE proposals SET preference_key = ? WHERE id = ?").run(preferenceKey, id);
  }

  getMetadata(key: string): string | undefined {
    return (this.db.prepare("SELECT value FROM metadata WHERE key = ?").get(key) as { value?: string } | undefined)?.value;
  }

  setMetadata(key: string, value: string): void {
    this.db.prepare("INSERT INTO metadata VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  metadataWithPrefix(prefix: string): Array<{ key: string; value: string }> {
    return this.db.prepare("SELECT key, value FROM metadata WHERE key LIKE ? ORDER BY key ASC").all(`${prefix}%`) as Array<{ key: string; value: string }>;
  }

  deleteMetadata(key: string): void {
    this.db.prepare("DELETE FROM metadata WHERE key = ?").run(key);
  }

  recordPreference(rule: Omit<PreferenceRule, "updatedAt">, now = new Date()): PreferenceRule {
    const updatedAt = now.toISOString();
    const reviewAfter = rule.reviewAfter ?? new Date(now.getTime() + 90 * 86_400_000).toISOString();
    this.db.prepare("INSERT INTO preferences (key, value, confidence, evidence_count, updated_at, expires_at, review_after) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, confidence = ((preferences.confidence * preferences.evidence_count) + (excluded.confidence * excluded.evidence_count)) / (preferences.evidence_count + excluded.evidence_count), evidence_count = preferences.evidence_count + excluded.evidence_count, updated_at = excluded.updated_at, expires_at = excluded.expires_at, review_after = excluded.review_after").run(rule.key, rule.value, rule.confidence, rule.evidenceCount, updatedAt, rule.expiresAt ?? null, reviewAfter);
    return this.preferences(now).find((preference) => preference.key === rule.key)!;
  }

  preferences(now = new Date()): PreferenceRule[] {
    this.db.prepare("DELETE FROM preferences WHERE expires_at IS NOT NULL AND expires_at <= ?").run(now.toISOString());
    return (this.db.prepare("SELECT * FROM preferences ORDER BY updated_at DESC").all() as Array<Record<string, unknown>>).map((row) => ({ key: String(row.key), value: String(row.value), confidence: Number(row.confidence), evidenceCount: Number(row.evidence_count), updatedAt: String(row.updated_at), ...(typeof row.expires_at === "string" ? { expiresAt: row.expires_at } : {}), ...(typeof row.review_after === "string" ? { reviewAfter: row.review_after } : {}) }));
  }

  deletePreference(key: string): boolean {
    return Number(this.db.prepare("DELETE FROM preferences WHERE key = ?").run(key).changes) === 1;
  }

  cleanup(retentionDays: number, now = new Date()): { proposals: number; briefings: number } {
    const cutoff = new Date(now.getTime() - Math.max(0, retentionDays) * 86_400_000).toISOString();
    const proposals = this.db.prepare("DELETE FROM proposals WHERE status NOT IN ('proposed','approved','executing','deferred','partially_completed') AND COALESCE(completed_at, created_at) <= ?").run(cutoff);
    const briefings = this.db.prepare("DELETE FROM briefings WHERE created_at <= ? AND (status = 'delivered' OR superseded_at IS NOT NULL)").run(cutoff);
    this.db.prepare("DELETE FROM action_claims WHERE status NOT IN ('executing','partially_completed') AND updated_at <= ?").run(cutoff);
    this.db.prepare("DELETE FROM metadata WHERE (key LIKE 'chief-of-staff:email-reviewed:%' OR key LIKE 'chief-of-staff:reported-failure:%') AND value <= ?").run(cutoff);
    return { proposals: Number(proposals.changes), briefings: Number(briefings.changes) };
  }

  updateEmailDraftBody(ownerSpaceId: string, ordinal: number, body: string): Proposal | undefined {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const briefing = this.db.prepare("SELECT id, proposal_ids_json, proposal_hashes_json FROM briefings WHERE owner_space_id = ? AND status = 'delivered' AND superseded_at IS NULL ORDER BY delivered_at DESC LIMIT 1").get(ownerSpaceId) as { id: string; proposal_ids_json?: string; proposal_hashes_json?: string } | undefined;
      const id = briefing?.proposal_ids_json ? (JSON.parse(briefing.proposal_ids_json) as string[])[ordinal - 1] : undefined;
      const proposal = id ? this.get(id) : undefined;
      const hashes: Record<string, string> = briefing?.proposal_hashes_json ? JSON.parse(briefing.proposal_hashes_json) : {};
      if (!proposal || proposal.kind !== "email_draft" || proposal.status !== "proposed" || hashes[proposal.id] !== proposal.payloadHash || proposal.payloadHash !== createHash("sha256").update(JSON.stringify(proposal.payload)).digest("hex")) { this.db.exec("COMMIT"); return undefined; }
      const payload = proposal.payload as Record<string, unknown>;
      const payloadJson = JSON.stringify({ ...payload, body });
      const payloadHash = createHash("sha256").update(payloadJson).digest("hex");
      this.db.prepare("UPDATE proposals SET payload_json = ?, payload_hash = ?, detail = ? WHERE id = ? AND status = 'proposed'").run(payloadJson, payloadHash, body, proposal.id);
      // The explicit owner edit supplies the new body; all other fields retain their reviewed version.
      hashes[proposal.id] = payloadHash;
      this.db.prepare("UPDATE briefings SET proposal_hashes_json = ? WHERE id = ?").run(JSON.stringify(hashes), briefing!.id);
      const updated = this.get(proposal.id);
      this.db.exec("COMMIT");
      return updated;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  parseCommand(ownerSpaceId: string, text: string, now = new Date(), timezone = "UTC"): ProposalCommand | undefined {
    const active = this.db.prepare("SELECT proposal_ids_json FROM briefings WHERE owner_space_id = ? AND status = 'delivered' AND superseded_at IS NULL ORDER BY delivered_at DESC LIMIT 1").get(ownerSpaceId) as { proposal_ids_json?: string } | undefined;
    const activeIds = active?.proposal_ids_json ? JSON.parse(active.proposal_ids_json) as string[] : [];
    let normalized = text.trim();
    if (activeIds.length === 1) {
      if (/^why (?:this|that)\??$/i.test(normalized)) normalized = "why 1";
      else if (/^(approve|reject|ignore|not important|show|done|got it|always surface)$/i.test(normalized)) normalized = `${normalized} 1`;
      else if (/^not now\s+(.+)$/i.test(normalized) && !/\s\d+$/.test(normalized)) normalized = `${normalized} 1`;
    }
    const match = normalized.match(/^(?:(approve|reject|ignore|not important|why|show|done|got it|always surface)\s+(\d+)|not now\s+(.+?)\s+(\d+))$/i);
    if (!match) return undefined;
    const verb = (match[1] ?? "defer").toLowerCase();
    const ordinal = Number(match[2] ?? match[4]);
    if (!Number.isInteger(ordinal) || ordinal < 1) return undefined;
    const briefing = this.db.prepare("SELECT proposal_ids_json FROM briefings WHERE owner_space_id = ? AND status = 'delivered' AND superseded_at IS NULL ORDER BY delivered_at DESC LIMIT 1").get(ownerSpaceId) as { proposal_ids_json?: string } | undefined;
    const id = briefing?.proposal_ids_json ? (JSON.parse(briefing.proposal_ids_json) as string[])[ordinal - 1] : undefined;
    if (!id) return undefined;
    const proposal = this.get(id);
    if (!proposal || proposal.ownerSpaceId !== ownerSpaceId || proposal.status !== "proposed" || Date.parse(proposal.expiresAt) <= now.getTime()) return undefined;
    if (verb === "why") return { type: "explain", proposal };
    if (verb === "show") return { type: "show", proposal };
    if (verb === "done" || verb === "got it") {
      this.db.prepare("UPDATE proposals SET status = 'completed', completed_at = ?, outcome = ? WHERE id = ? AND status = 'proposed'").run(now.toISOString(), "The owner said this was already done.", id);
      return { type: "done", proposal: { ...proposal, status: "completed", completedAt: now.toISOString(), outcome: "The owner said this was already done." } };
    }
    if (verb === "always surface") return { type: "always_surface", proposal };
    if (verb === "approve") {
      const snapshot = this.db.prepare("SELECT id, proposal_hashes_json FROM briefings WHERE owner_space_id = ? AND status = 'delivered' AND superseded_at IS NULL ORDER BY delivered_at DESC LIMIT 1").get(ownerSpaceId) as { id: string; proposal_hashes_json?: string } | undefined;
      return { type: "approve", proposal: { ...proposal, reviewedBriefingId: snapshot?.id, reviewedPayloadHash: snapshot?.proposal_hashes_json ? (JSON.parse(snapshot.proposal_hashes_json) as Record<string, string>)[id] : undefined } };
    }
    if (verb === "reject" || verb === "ignore" || verb === "not important") {
      const status = verb === "reject" ? "rejected" : "ignored";
      this.db.prepare("UPDATE proposals SET status = ? WHERE id = ? AND status = 'proposed'").run(status, id);
      const disposition = verb === "reject" ? "rejected" : verb === "ignore" ? "ignored" : "not_important";
      return { type: "reject", proposal: { ...proposal, status }, disposition };
    }
    const until = resolveDeferDate(match[3]!, now, timezone);
    if (!until) return undefined;
    this.db.prepare("UPDATE proposals SET status = 'deferred', deferred_until = ? WHERE id = ? AND status = 'proposed'").run(until, id);
    return { type: "defer", proposal: { ...proposal, status: "deferred" }, until };
  }

  private get(id: string): Proposal | undefined {
    const row = this.db.prepare("SELECT * FROM proposals WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id), ownerSpaceId: String(row.owner_space_id), kind: row.kind as ProposalKind,
      summary: String(row.summary), detail: String(row.detail), payload: JSON.parse(String(row.payload_json)),
      payloadHash: typeof row.payload_hash === "string" ? row.payload_hash : createHash("sha256").update(String(row.payload_json)).digest("hex"),
      ...(typeof row.source_key === "string" ? { sourceKey: row.source_key } : {}),
      evidence: JSON.parse(String(row.evidence_json)), status: row.status as ProposalStatus,
      createdAt: String(row.created_at), expiresAt: String(row.expires_at),
      ...(typeof row.approved_at === "string" ? { approvedAt: row.approved_at } : {}),
      ...(typeof row.completed_at === "string" ? { completedAt: row.completed_at } : {}),
      ...(typeof row.outcome === "string" ? { outcome: row.outcome } : {}),
      ...(typeof row.deferred_until === "string" ? { deferredUntil: row.deferred_until } : {}),
      ...(typeof row.owner_feedback === "string" ? { ownerFeedback: row.owner_feedback } : {}),
      ...(typeof row.preference_key === "string" ? { preferenceKey: row.preference_key } : {}),
      ...(typeof row.last_notified_at === "string" ? { lastNotifiedAt: row.last_notified_at } : {}),
    };
  }
}

export function startProposalCleanup(ledger: ProposalLedger, retentionDays: number, intervalMs = 6 * 60 * 60 * 1000): () => void {
  return startPoller("Chief of staff data cleanup", intervalMs, async () => { ledger.cleanup(retentionDays); });
}
