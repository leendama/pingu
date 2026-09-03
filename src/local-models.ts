export interface LocalModelEndpoint {
  name: "Ollama" | "LM Studio";
  baseUrl: string;
  models: string[];
}

/** Where the usual local servers listen, on this machine and, from inside Docker, on the host. */
const CANDIDATES: Array<Omit<LocalModelEndpoint, "models">> = [
  { name: "Ollama", baseUrl: "http://localhost:11434/v1" },
  { name: "LM Studio", baseUrl: "http://localhost:1234/v1" },
  { name: "Ollama", baseUrl: "http://host.docker.internal:11434/v1" },
  { name: "LM Studio", baseUrl: "http://host.docker.internal:1234/v1" },
];

type FetchLike = (input: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/**
 * Find a running local model server so the wizard can preselect it. Each
 * candidate gets a short timeout; a machine without one answers in well under
 * a second. Models are listed so the wizard can offer a real default.
 */
export async function detectLocalModelEndpoint(fetchImpl: FetchLike = fetch, timeoutMs = 1_200): Promise<LocalModelEndpoint | undefined> {
  for (const candidate of CANDIDATES) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${candidate.baseUrl}/models`, { signal: controller.signal });
      if (!response.ok) continue;
      const body = await response.json() as { data?: Array<{ id?: unknown }> };
      const models = (body.data ?? []).map((model) => model.id).filter((id): id is string => typeof id === "string");
      return { ...candidate, models };
    } catch {
      continue;
    } finally {
      clearTimeout(timer);
    }
  }
  return undefined;
}

/** A tool-capable default from what the server offers, preferring names known to support function calling. */
export function preferredLocalModel(models: string[]): string | undefined {
  const preferred = models.find((model) => /gpt-oss|llama3\.[1-9]|qwen|mistral|command-r|firefunction|hermes/i.test(model));
  return preferred ?? models[0];
}
