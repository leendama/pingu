import "./env.js";
import { dataPath } from "./state.js";
import { deleteAllPinguData, PINGU_DATA_FILES } from "./transcripts.js";

async function main(): Promise<void> {
  if (!process.argv.includes("--yes")) {
    console.log(`This removes every chat transcript and these files under ${dataPath("")}:\n  ${PINGU_DATA_FILES.join("\n  ")}\n`);
    console.log("Encrypted credentials and Google tokens are kept. Run again with --yes to delete.");
    return;
  }
  const result = await deleteAllPinguData();
  console.log(`Deleted ${result.transcripts} transcript(s) and ${result.files.length} data file(s).`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
