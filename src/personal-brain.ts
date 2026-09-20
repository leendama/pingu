import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

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
  /** Explicit outgoing links only. A graph edge is not proof of a thematic claim. */
  async links(name: string) {
    const note = await this.read(name);
    const root = await realpath(this.root);
    const paths: string[] = [];
    let directories = 0;
    const walk = async (dir: string, depth = 0): Promise<void> => {
      if (depth > 12 || directories++ >= 1000) return;
      for (const e of await readdir(dir, { withFileTypes: true })) {
        if (paths.length >= 3000) return;
        if (e.name.startsWith(".") || e.isSymbolicLink()) continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) await walk(p, depth + 1);
        else if (e.isFile() && e.name.endsWith(".md")) paths.push(relative(root, p));
      }
    };
    await walk(root);
    const targets = [...note.content.matchAll(/\[\[([^\]\n]+)\]\]/g)].map(m => ({ target: m[1]!.split("|")[0]!.split("#")[0]!.trim(), wiki: true }));
    targets.push(...[...note.content.matchAll(/\[[^\]\n]*\]\(([^)\s]+)\)/g)].map(m => ({ target: m[1]!.split("#")[0]!, wiki: false })));
    const links = [];
    for (const { target, wiki } of targets.slice(0, 50)) {
      if (!target || /^[a-z][a-z\d+.-]*:/i.test(target)) continue;
      let decoded: string;
      try { decoded = decodeURIComponent(target); } catch { continue; }
      const md = decoded.endsWith(".md") ? decoded : `${decoded}.md`;
      const rel = relative(root, resolve(root, dirname(name), md));
      const exact = wiki && paths.includes(md) ? md : paths.includes(rel) ? rel : undefined;
      const candidates = exact ? [exact] : wiki && !md.includes("/") ? paths.filter(p => basename(p) === md) : [];
      if (candidates.length !== 1) { links.push({ target, status: candidates.length ? "ambiguous" : "missing" }); continue; }
      try {
        const linked = await this.read(candidates[0]!);
        links.push({ target, status: "resolved", path: linked.path, source: linked.source, excerpt: linked.content.slice(0, 1000), truncated: linked.content.length > 1000 || linked.truncated });
      } catch { links.push({ target, status: "unavailable" }); }
    }
    return { source: note.source, links, limited: paths.length >= 3000 || directories >= 1000 || targets.length > 50 || note.truncated, note: "Explicit note links only, not verified conceptual relationships. Read each full note before claiming a connection. Missing and ambiguous links must not be guessed." };
  }
  async search(query: string) {
    const root = await realpath(this.root);
    const stop = new Set(["the", "and", "with", "what", "about", "from", "for", "does", "have", "into"]);
    const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu)?.filter((s) => s.length > 1 && !stop.has(s)) ?? [])].slice(0, 10);
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
        const words = new Set(lower.match(/[\p{L}\p{N}]+/gu) ?? []);
        const titleWords = new Set(entry.name.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
        const matched = terms.filter(t => words.has(t) || titleWords.has(t));
        const score = matched.length * 2 + matched.filter(t => titleWords.has(t)).length * 3 + (matched.length === terms.length ? 3 : 0);
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
