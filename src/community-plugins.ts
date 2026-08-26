import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AssistantPlugin } from "./plugins.js";

// Import trusted plugins here and add them to this list. See docs/PLUGINS.md.
export const communityPlugins: AssistantPlugin[] = [];

function pluginsFromModule(module: Record<string, unknown>, filename: string): AssistantPlugin[] {
  const exported = module.plugins ?? module.default;
  const plugins = Array.isArray(exported) ? exported : exported ? [exported] : [];
  if (plugins.length === 0) throw new Error(`External plugin ${filename} must export a plugin or plugins array.`);
  return plugins as AssistantPlugin[];
}

export async function loadCommunityPlugins(): Promise<AssistantPlugin[]> {
  const directory = process.env.PINGU_PLUGIN_DIR?.trim();
  if (!directory) return communityPlugins;
  const absoluteDirectory = resolve(directory);
  const filenames = (await readdir(absoluteDirectory))
    .filter((filename) => /\.(?:mjs|js|ts)$/.test(filename) && !/\.(?:test|spec)\.[^.]+$/.test(filename))
    .sort();
  const external: AssistantPlugin[] = [];
  for (const filename of filenames) {
    const module = await import(pathToFileURL(resolve(absoluteDirectory, filename)).href) as Record<string, unknown>;
    external.push(...pluginsFromModule(module, filename));
  }
  return [...communityPlugins, ...external];
}
