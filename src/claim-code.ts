import "./env.js";
import { CLAIM_CODE_TTL_MS, issueClaimCode, listOwners } from "./owners.js";

async function main(): Promise<void> {
  const claim = await issueClaimCode();
  const minutes = Math.round(CLAIM_CODE_TTL_MS / 60_000);
  console.log(`Text this code to your Pingu number within ${minutes} minutes:\n\n  ${claim.code}\n`);
  console.log("The number that sends it becomes a verified owner. Keep the assistant running while you text it.");
  const owners = await listOwners();
  if (owners.length) console.log(`Verified owners so far: ${owners.length}.`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
