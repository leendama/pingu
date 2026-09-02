import { randomInt } from "node:crypto";
import type { SenderRole } from "./plugins.js";
import { JsonFileStore } from "./state.js";

/** A sender Pingu has verified as the owner, recorded by the exact id Spectrum reports. */
export interface OwnerRecord {
  senderId: string;
  /** The direct-message space the owner claimed from; approvals and notices go here. */
  spaceId?: string;
  label?: string;
  verifiedAt: string;
}

interface ClaimCode {
  code: string;
  issuedAt: string;
  expiresAt: string;
}

interface OwnersState {
  version: 1;
  owners: OwnerRecord[];
  claim?: ClaimCode;
}

const store = new JsonFileStore<OwnersState>(
  "owners.json",
  () => ({ version: 1, owners: [] }),
  (value) => {
    const record = value && typeof value === "object" ? value as Partial<OwnersState> : {};
    return {
      version: 1,
      owners: Array.isArray(record.owners)
        ? record.owners.filter((owner): owner is OwnerRecord => Boolean(owner && typeof owner === "object" && typeof owner.senderId === "string"))
        : [],
      claim: record.claim && typeof record.claim === "object" && typeof record.claim.code === "string" ? record.claim : undefined,
    };
  },
);

export const CLAIM_CODE_TTL_MS = 60 * 60 * 1000;
const CLAIM_PREFIX = "PINGU-";
/** No 0/O/1/I so a code read from a screen cannot be mistyped. */
const CLAIM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateClaimCode(): string {
  let suffix = "";
  for (let index = 0; index < 6; index += 1) suffix += CLAIM_ALPHABET[randomInt(CLAIM_ALPHABET.length)];
  return `${CLAIM_PREFIX}${suffix}`;
}

/** Uppercase and strip separators so "pingu 4f7k 2q" still matches PINGU-4F7K2Q. */
export function normaliseClaimText(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function looksLikeClaimCode(text: string): boolean {
  return /^PINGU[A-Z0-9]{6}$/.test(normaliseClaimText(text));
}

export async function issueClaimCode(now = Date.now()): Promise<ClaimCode> {
  const claim: ClaimCode = {
    code: generateClaimCode(),
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + CLAIM_CODE_TTL_MS).toISOString(),
  };
  await store.update((state) => {
    state.claim = claim;
    return { result: undefined, changed: true };
  });
  return claim;
}

export async function activeClaimCode(now = Date.now()): Promise<ClaimCode | undefined> {
  const claim = (await store.read()).claim;
  return claim && Date.parse(claim.expiresAt) > now ? claim : undefined;
}

export type ClaimOutcome = "verified" | "expired" | "no-match";

/**
 * Redeem a claim code texted to Pingu. The sender id is recorded exactly as
 * Spectrum reported it; a typed phone number is never trusted. Returns
 * undefined when the text is not a claim code at all.
 */
export async function redeemClaimCode(
  text: string,
  sender: { senderId: string; spaceId?: string; label?: string },
  now = Date.now(),
): Promise<ClaimOutcome | undefined> {
  if (!looksLikeClaimCode(text)) return undefined;
  const supplied = normaliseClaimText(text);
  return store.update<ClaimOutcome>((state) => {
    const claim = state.claim;
    if (!claim || normaliseClaimText(claim.code) !== supplied) return { result: "no-match", changed: false };
    if (Date.parse(claim.expiresAt) <= now) {
      state.claim = undefined;
      return { result: "expired", changed: true };
    }
    state.claim = undefined;
    const existing = state.owners.find((owner) => owner.senderId === sender.senderId);
    if (existing) {
      existing.spaceId = sender.spaceId ?? existing.spaceId;
      existing.verifiedAt = new Date(now).toISOString();
    } else {
      state.owners.push({ senderId: sender.senderId, spaceId: sender.spaceId, label: sender.label, verifiedAt: new Date(now).toISOString() });
    }
    return { result: "verified", changed: true };
  });
}

/** Extra verified sender ids from the environment, for people who already know the exact id Spectrum reports. */
function environmentOwnerIds(): string[] {
  return (process.env.PINGU_OWNER_SENDER_IDS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
}

export async function listOwners(): Promise<OwnerRecord[]> {
  return (await store.read()).owners;
}

export async function removeOwner(senderId: string): Promise<boolean> {
  return store.update((state) => {
    const remaining = state.owners.filter((owner) => owner.senderId !== senderId);
    if (remaining.length === state.owners.length) return { result: false, changed: false };
    state.owners = remaining;
    return { result: true, changed: true };
  });
}

export async function isOwnerSender(senderId: string | undefined): Promise<boolean> {
  if (!senderId) return false;
  if (environmentOwnerIds().includes(senderId)) return true;
  return (await listOwners()).some((owner) => owner.senderId === senderId);
}

/** A missing sender fails closed: whoever the platform could not identify is a guest. */
export async function resolveSenderRole(senderId: string | undefined): Promise<SenderRole> {
  return (await isOwnerSender(senderId)) ? "owner" : "guest";
}

/** Direct-message spaces where a verified owner can be reached. */
export async function ownerSpaceIds(): Promise<string[]> {
  return (await listOwners()).map((owner) => owner.spaceId).filter((spaceId): spaceId is string => Boolean(spaceId));
}

export async function hasVerifiedOwner(): Promise<boolean> {
  return environmentOwnerIds().length > 0 || (await listOwners()).length > 0;
}
