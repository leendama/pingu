import type { ProposalLedger } from "./proposals.js";

export type EmailAlertMode = "urgent" | "actionable";
export const ACTIONABLE_ALERT_CONFIDENCE = 0.85;

export function emailAlertMode(ledger: Pick<ProposalLedger, "getMetadata">, spaceId: string): EmailAlertMode {
  return ledger.getMetadata(`chief-of-staff:email-alert-mode:${spaceId}`) === "actionable" ? "actionable" : "urgent";
}

export function setEmailAlertMode(ledger: Pick<ProposalLedger, "setMetadata">, spaceId: string, mode: EmailAlertMode): void {
  ledger.setMetadata(`chief-of-staff:email-alert-mode:${spaceId}`, mode);
}

export function actionableAlert(review: { outcome?: string; confidence: number }): boolean {
  return (review.outcome === "draft" || review.outcome === "decision")
    && Number.isFinite(review.confidence) && review.confidence >= ACTIONABLE_ALERT_CONFIDENCE;
}
