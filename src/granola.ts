import type { GranolaPort } from "./capabilities/granola.js";

import { setTimeout as delay } from "node:timers/promises";

// Share a request-start queue across foreground reads and background reviews.
let requestSlot=Promise.resolve();
async function waitForRequestSlot(){
  const ready=requestSlot;
  requestSlot=ready.then(()=>delay(250));
  await ready;
}

const GRANOLA_API_URL = "https://public-api.granola.ai/v1";

async function granolaRequest(path: string, suppliedApiKey?: string): Promise<unknown> {
  const apiKey = suppliedApiKey ?? process.env.GRANOLA_API_KEY;
  if (!apiKey) {
    throw new Error("Granola is not connected. Add GRANOLA_API_KEY to .env.");
  }

  await waitForRequestSlot();
  const response = await fetch(`${GRANOLA_API_URL}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(30_000),
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
      if (options.updatedAfter) params.set("updated_after",options.updatedAfter);
      if (options.cursor) params.set("cursor",options.cursor);
      params.set("page_size", String(Math.min(Math.max(options.pageSize, 1), 30)));
      return granolaRequest(`/notes?${params}`, apiKey);
    },
    getNote: async (noteId, includeTranscript) => {
      if (!/^not_[a-zA-Z0-9]{14}$/.test(noteId)) throw new Error("Invalid Granola note ID.");
      return granolaRequest(`/notes/${encodeURIComponent(noteId)}${includeTranscript ? "?include=transcript" : ""}`, apiKey);
    },
  };
}
