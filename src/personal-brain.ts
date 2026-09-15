import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** Bounded Markdown-only access. Hidden directories and symlinks are never sources. */
export class PersonalBrain {
  constructor(private readonly root: string) {}
  private async path(name: string) {
    const root = await realpath(this.root);
    const path = resolve(root, name);
    const rel = relative(root, path);
    if (!rel || isAbsolute(rel) || rel.split(sep).some((p) => p === ".." || p.startsWith(".")) || !rel.endsWith(".md")) throw new Error("Use a Markdown path inside the configured vault.");
    let current = root;
    for (const part of rel.split(sep)) {
      current = join(current, part);
      if ((await lstat(current)).isSymbolicLink()) throw new Error("Vault symlinks are not supported.");
    }
    if ((await realpath(path)) !== path) throw new Error("Invalid vault path.");
    return path;
  }
  async read(name: string) {
    const path = await this.path(name);
    if ((await lstat(path)).size > 256_000) throw new Error("Note is too large; use a smaller source note.");
    const content = await readFile(path, "utf8");
    return { path: name, source: `obsidian://open?path=${encodeURIComponent(path)}`, content: content.slice(0, 16_000), truncated: content.length > 16_000 };
  }
  async search(query: string) {
    const root = await realpath(this.root);
    const terms = query.toLowerCase().match(/[\p{L}\p{N}]+/gu)?.filter((s) => s.length > 1).slice(0, 10) ?? [];
    if (!terms.length) throw new Error("Search needs a person, concept, or project name.");
    const hits: Array<{ path: string; source: string; excerpt: string; score: number }> = [];
    let scanned = 0;
    let directories = 0;
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 12 || directories++ >= 1000) return;
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (scanned >= 3000) return;
        if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) { await walk(path, depth + 1); continue; }
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        scanned++;
        if ((await lstat(path)).size > 256_000) continue;
        const text = (await readFile(path, "utf8")).slice(0, 64_000);
        const lower = text.toLowerCase();
        const score = terms.reduce((n, t) => n + (lower.includes(t) ? 1 : 0) + (entry.name.toLowerCase().includes(t) ? 2 : 0), 0);
        if (!score) continue;
        const lines = text.split("\n");
        const index = lines.findIndex((line) => terms.some((t) => line.toLowerCase().includes(t)));
        hits.push({ path: relative(root, path), source: `obsidian://open?path=${encodeURIComponent(path)}`, excerpt: lines.slice(Math.max(0, index - 1), index + 5).join("\n").slice(0, 700), score });
      }
    };
    await walk(root, 0);
    return { hits: hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, 8), scanned, limited: scanned >= 3000 || directories >= 1000, note: "Keyword candidates, not verified relationships. Read the notes before drawing conclusions. Missing results do not prove a conversation never happened." };
  }
  async capture(input: { title: string; content: string; source: string; kind: "recollection" | "source-summary" }, date: string) {
    const root = await realpath(this.root);
    const inbox = join(root, "inbox");
    await mkdir(inbox, { recursive: true });
    if ((await lstat(inbox)).isSymbolicLink()) throw new Error("Inbox must be a real vault directory.");
    const hash = createHash("sha256").update(JSON.stringify([date, input])).digest("hex").slice(0, 16);
    const filename = `${date}-capture-${hash}.md`;
    const text = `---\ntype: inbox-capture\ndate: ${date}\nsource: ${JSON.stringify(input.source)}\nevidence_kind: ${input.kind}\nstatus: unreviewed\n---\n\n# ${input.title.replace(/[\r\n]/g, " ")}\n\n${input.kind === "recollection" ? "Owner recollection; no recording or transcript. Details and attribution may be incomplete." : "Source summary; interpretations and suggestions need review."}\n\n${input.content}\n`;
    try { await writeFile(join(inbox, filename), text, { flag: "wx", mode: 0o600 }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
    return { saved: true, path: `inbox/${filename}`, source: `obsidian://open?path=${encodeURIComponent(join(inbox, filename))}`, status: "unreviewed" };
  }
}
