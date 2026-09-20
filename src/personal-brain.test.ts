import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PersonalBrain } from "./personal-brain.js";
import { personalBrainPlugin } from "./capabilities/personal-brain.js";
import { PluginRegistry, type ToolRunContext } from "./plugins.js";
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "pingu-brain-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
describe("private brain", () => {
  it("returns source-linked candidates and exposes actual note evidence", async () => {
    await writeFile(join(dir, "robotics.md"), "# Physical systems\nOwner recollection: generalisation was discussed.\n[[principles]]");
    const brain = new PersonalBrain(dir);
    const results = await brain.search("robotics generalisation");
    expect(results.hits).toMatchObject([{ path: "robotics.md", source: expect.stringContaining("obsidian://") }]);
    expect((await brain.read("robotics.md")).content).toContain("Owner recollection");
  });
  it("blocks traversal, hidden files, symlink files and symlink directories", async () => {
    const vault = join(dir, "vault"); await mkdir(vault);
    await writeFile(join(dir, "secret.md"), "private-outside-source");
    await symlink(join(dir, "secret.md"), join(vault, "link.md"));
    await symlink(dir, join(vault, "linked-folder"));
    await mkdir(join(vault, ".config")); await writeFile(join(vault, ".config/secret.md"), "private-hidden-source");
    const brain = new PersonalBrain(vault);
    for (const path of ["../secret.md", "link.md", "linked-folder/secret.md", ".config/secret.md"]) await expect(brain.read(path)).rejects.toThrow();
    expect((await brain.search("private")).hits).toEqual([]);
  });
  it("captures recollection once into the inbox without claiming a recording or changing a principle", async () => {
    const brain = new PersonalBrain(dir);
    const input = { title: "A conversation", content: "We discussed robotics; attribution is incomplete.", source: "owner recollection in chat", kind: "recollection" as const };
    const saved = await brain.capture(input, "2026-08-01");
    expect(await brain.capture(input, "2026-08-01")).toEqual(saved);
    expect(await readFile(join(dir, saved.path), "utf8")).toContain("no recording or transcript");
    expect(saved.path).toMatch(/^inbox\//);
  });
  it("keeps brain tools unavailable in guests and groups, including direct invocation", async () => {
    const registry = new PluginRegistry([personalBrainPlugin(dir)]);
    for (const audience of [{ role: "guest" as const, isGroup: false }, { role: "owner" as const, isGroup: true }]) {
      expect(registry.toolsFor(audience)).toEqual([]);
      const result = await registry.run("search_personal_brain", '{"query":"secret"}', { ...audience, spaceId: "owner" } as ToolRunContext);
      expect(JSON.stringify(result)).toContain("error");
    }
  });
});

it("follows explicit links and refuses ambiguous title matches", async () => {
 await mkdir(join(dir,"principles")); await mkdir(join(dir,"lessons"));
 await writeFile(join(dir,"meeting.md"),"[[principles/test|test first]] [[same]] [[missing]] [lesson](lessons/review.md)");
 await writeFile(join(dir,"principles/test.md"),"# Test first\nEvidence before launch.");
 await writeFile(join(dir,"principles/same.md"),"one"); await writeFile(join(dir,"lessons/same.md"),"two");
 await writeFile(join(dir,"lessons/review.md"),"Review the evidence.");
 const result=await new PersonalBrain(dir).links("meeting.md");
 expect(result.links).toMatchObject([{status:"resolved",path:"principles/test.md"},{status:"ambiguous"},{status:"missing"},{status:"resolved",path:"lessons/review.md"}]);
});
it("does not match a person's name as a substring of a different word", async()=>{
 await writeFile(join(dir,"discussion.md"),"A shimmering opportunity");
 expect((await new PersonalBrain(dir).search("mer")).hits).toEqual([]);
});
