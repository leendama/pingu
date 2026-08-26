import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadCommunityPlugins } from "./community-plugins.js";

const directories: string[] = [];

afterEach(async () => {
  delete process.env.PINGU_PLUGIN_DIR;
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("external community plugins", () => {
  it("loads plugins from the configured private directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pingu-plugins-test-"));
    directories.push(directory);
    await writeFile(join(directory, "private-plugin.mjs"), `export default {
      id: "private-example",
      name: "Private example",
      tools: [],
      async run() { return { output: "ok" }; }
    };`);
    process.env.PINGU_PLUGIN_DIR = directory;

    const plugins = await loadCommunityPlugins();

    expect(plugins.map((plugin) => plugin.id)).toContain("private-example");
  });

  it("returns only bundled plugins when no directory is configured", async () => {
    expect(await loadCommunityPlugins()).toEqual([]);
  });
});
