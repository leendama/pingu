import { z } from "zod";
import { PersonalBrain } from "../personal-brain.js";
import { localDate } from "../daily-review.js";
import { capabilityPlugin } from "../tools.js";
const query = z.object({ query: z.string().min(2).max(200) });
const path = z.object({ path: z.string().min(1).max(500) });
const capture = z.object({ title: z.string().min(1).max(150), content: z.string().min(1).max(12000), source: z.string().min(1).max(1000), kind: z.enum(["recollection", "source-summary"]) });
const fn = (name: string, description: string, schema: z.ZodType) => ({ type: "function" as const, name, description, strict: true, parameters: z.toJSONSchema(schema) });
export function personalBrainPlugin(root: string) {
  const brain = new PersonalBrain(root);
  return capabilityPlugin({ id: "personal-brain", name: "Personal brain", description: "Private source-linked Markdown retrieval and inbox capture.", instructions: [
    "Use search_personal_brain and read_personal_note for the owner's people, prior conversations, principles, lessons, and learning priorities. Cite the returned sources. A topical match is not evidence of a causal link or repeated pattern; distinguish direct evidence, recollection, and your suggestion. If nothing reliable supports a connection, say so.",
    "Capture unrecorded conversations only from what the owner actually tells you. Label them recollection; never fabricate quotes, commitments, recordings, or missing details. New captures go to the inbox for review. Do not promote suggestions to principles or overwrite notes.",
  ] }, [
    { schema: fn("search_personal_brain", "Search the private Obsidian brain by person, theme, project or priority. Results are candidates; read sources before synthesizing.", query), sideEffecting: false, untrustedSource: true, run: async (a) => ({ output: JSON.stringify(await brain.search(query.parse(a).query)) }) },
    { schema: fn("read_personal_note", "Read a Markdown note using a relative path from search, including its source and evidence labels.", path), sideEffecting: false, untrustedSource: true, run: async (a) => ({ output: JSON.stringify(await brain.read(path.parse(a).path)) }) },
    { schema: fn("capture_personal_note", "Save an owner-requested capture into the private inbox. Recollections must say no recording exists. Never invent supporting evidence.", capture), safeAfterUntrusted: true, run: async (a, c) => ({ output: JSON.stringify(await brain.capture(capture.parse(a), localDate(Date.now(), c.config.timezone))) }) },
  ]);
}
