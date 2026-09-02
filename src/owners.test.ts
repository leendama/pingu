import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CLAIM_CODE_TTL_MS, activeClaimCode, generateClaimCode, hasVerifiedOwner, isOwnerSender, issueClaimCode,
  listOwners, looksLikeClaimCode, normaliseClaimText, ownerSpaceIds, redeemClaimCode, removeOwner, resolveSenderRole,
} from "./owners.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "pingu-owners-test-"));
  process.env.PHOTON_DATA_DIR = directory;
  delete process.env.PINGU_OWNER_SENDER_IDS;
});

afterEach(async () => {
  delete process.env.PHOTON_DATA_DIR;
  delete process.env.PINGU_OWNER_SENDER_IDS;
  await rm(directory, { recursive: true, force: true });
});

describe("claim codes", () => {
  it("generates readable codes and matches them loosely", () => {
    const code = generateClaimCode();
    expect(code).toMatch(/^PINGU-[A-HJ-NP-Z2-9]{6}$/);
    expect(looksLikeClaimCode(code.toLowerCase())).toBe(true);
    expect(looksLikeClaimCode("pingu 4f7k 2q")).toBe(true);
    expect(looksLikeClaimCode("yes")).toBe(false);
    expect(normaliseClaimText("pingu-4F7K 2q")).toBe("PINGU4F7K2Q");
  });

  it("records the exact sender id that texts the active code", async () => {
    const claim = await issueClaimCode(1_000);
    expect(await activeClaimCode(2_000)).toMatchObject({ code: claim.code });
    expect(await resolveSenderRole("+15550101000")).toBe("guest");
    expect(await redeemClaimCode(claim.code.toLowerCase(), { senderId: "+15550101000", spaceId: "dm-1" }, 2_000)).toBe("verified");
    expect(await resolveSenderRole("+15550101000")).toBe("owner");
    expect(await ownerSpaceIds()).toEqual(["dm-1"]);
    expect(await hasVerifiedOwner()).toBe(true);
    expect(await activeClaimCode(3_000)).toBeUndefined();
  });

  it("refuses a code that expired, mismatched, or was already used", async () => {
    const claim = await issueClaimCode(0);
    expect(await redeemClaimCode(claim.code, { senderId: "a" }, CLAIM_CODE_TTL_MS + 1)).toBe("expired");
    expect(await listOwners()).toEqual([]);

    await issueClaimCode(0);
    expect(await redeemClaimCode("PINGU-ZZZZZZ", { senderId: "a" }, 1)).toBe("no-match");
    expect(await redeemClaimCode("hello there", { senderId: "a" }, 1)).toBeUndefined();
  });

  it("fails closed for a missing sender and honours the environment allowlist", async () => {
    expect(await isOwnerSender(undefined)).toBe(false);
    expect(await resolveSenderRole(undefined)).toBe("guest");
    process.env.PINGU_OWNER_SENDER_IDS = "known-1, known-2";
    expect(await resolveSenderRole("known-2")).toBe("owner");
    expect(await resolveSenderRole("known-3")).toBe("guest");
  });

  it("removes an owner so the number becomes a guest again", async () => {
    const claim = await issueClaimCode(0);
    await redeemClaimCode(claim.code, { senderId: "x", spaceId: "dm" }, 1);
    expect(await removeOwner("x")).toBe(true);
    expect(await removeOwner("x")).toBe(false);
    expect(await resolveSenderRole("x")).toBe("guest");
  });
});
