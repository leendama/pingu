import type { GranolaPort } from "./capabilities/granola.js";

const GRANOLA_API_URL = "https://public-api.granola.ai/v1";

async function granolaRequest(path: string, suppliedApiKey?: string): Promise<unknown> {
  const apiKey = suppliedApiKey ?? process.env.GRANOLA_API_KEY;
  if (!apiKey) {
    throw new Error("Granola is not connected. Add GRANOLA_API_KEY to .env.");
  }

  const response = await fetch(`${GRANOLA_API_URL}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!response.ok) {
    throw new Error(`Granola request failed (${response.status}). Check the API key and workspace access.`);
  }

  return response.json();
}

export function granolaPort(apiKey?: string): GranolaPort {
  return {
    listNotes: async (options) => {
      const params = new URLSearchParams();
      if (options.createdAfter) params.set("created_after", options.createdAfter);
      if (options.createdBefore) params.set("created_before", options.createdBefore);
      params.set("page_size", String(Math.min(Math.max(options.pageSize, 1), 30)));
      return granolaRequest(`/notes?${params}`, apiKey);
    },
    getNote: async (noteId, includeTranscript) => {
      if (!/^not_[a-zA-Z0-9]{14}$/.test(noteId)) throw new Error("Invalid Granola note ID.");
      return granolaRequest(`/notes/${encodeURIComponent(noteId)}${includeTranscript ? "?include=transcript" : ""}`, apiKey);
    },
  };
}
