import type { ProposalLedger } from "./proposals.js";

const QUESTIONS = [
  "What do you do every week?",
  "What takes way too long?",
  "What would you hand off first?",
  "What are your main priorities right now?",
  "What should I never do without asking?",
  "What would make a daily chief-of-staff check genuinely useful?",
] as const;

interface InterviewState { answers: string[]; startedAt: string; }
export interface OperatingBrief { answers: string[]; completedAt: string; }

function activeKey(spaceId: string): string { return `chief-of-staff:interview:${spaceId}`; }
function briefKey(spaceId: string): string { return `chief-of-staff:operating-brief:${spaceId}`; }
function preferenceKey(spaceId: string): string { return `chief-of-staff:owner-preferences:${spaceId}`; }
function read<T>(ledger: ProposalLedger, key: string): T | undefined {
  try { return JSON.parse(ledger.getMetadata(key) ?? "") as T; } catch { return undefined; }
}

export function operatingBrief(ledger: ProposalLedger, spaceId: string): OperatingBrief | undefined {
  const value = read<OperatingBrief>(ledger, briefKey(spaceId));
  return value && Array.isArray(value.answers) ? value : undefined;
}

export function operatingBriefText(ledger: ProposalLedger, spaceId: string): string | undefined {
  const brief = operatingBrief(ledger, spaceId);
  const saved = read<string[]>(ledger, preferenceKey(spaceId));
  const preferences = Array.isArray(saved) ? saved.filter((item): item is string => typeof item === "string").slice(-10) : [];
  const text = [
    ...(brief ? QUESTIONS.map((question, index) => `${question} ${brief.answers[index] ?? "Not answered."}`) : []),
    ...preferences.map((preference) => `Explicit owner preference: ${preference}`),
  ].join("\n");
  return text || undefined;
}

export function handleChiefInterview(ledger: ProposalLedger, spaceId: string, texts: readonly string[], now = new Date()): string | undefined {
  const text = texts.at(-1)?.trim() ?? "";
  const preference = text.match(/^remember preference:\s*([\s\S]+)$/i)?.[1]?.trim();
  if (preference) {
    const saved = read<string[]>(ledger, preferenceKey(spaceId));
    const previous = Array.isArray(saved) ? saved.filter((item): item is string => typeof item === "string") : [];
    ledger.setMetadata(preferenceKey(spaceId), JSON.stringify([...new Set([...previous, preference.slice(0, 1_000)])].slice(-10)));
    return "Saved. I’ll use that when replying and reviewing your day.";
  }
  if (/^clear message preferences$/i.test(text)) {
    ledger.deleteMetadata(preferenceKey(spaceId));
    return "Cleared your saved message preferences.";
  }
  const state = read<InterviewState>(ledger, activeKey(spaceId));
  if (!state) {
    if (/^(?:start|begin|set up) (?:the )?chief(?: of staff)? interview$/i.test(text)) {
      ledger.setMetadata(activeKey(spaceId), JSON.stringify({ answers: [], startedAt: now.toISOString() } satisfies InterviewState));
      return `Chief-of-staff setup. ${QUESTIONS[0]}`;
    }
    if (/^(?:show|view) (?:my )?(?:chief(?: of staff)? )?operating brief$/i.test(text)) {
      const brief = operatingBriefText(ledger, spaceId);
      return brief ? `Your operating brief:\n${brief}` : "No operating brief yet. Say “start chief interview”.";
    }
    return undefined;
  }
  if (/^cancel$/i.test(text)) {
    ledger.deleteMetadata(activeKey(spaceId));
    return "Cancelled. Nothing saved.";
  }
  if (!text) return QUESTIONS[state.answers.length];
  const answers = [...state.answers, text.slice(0, 1_500)];
  if (answers.length < QUESTIONS.length) {
    ledger.setMetadata(activeKey(spaceId), JSON.stringify({ ...state, answers } satisfies InterviewState));
    return QUESTIONS[answers.length];
  }
  ledger.setMetadata(briefKey(spaceId), JSON.stringify({ answers, completedAt: now.toISOString() } satisfies OperatingBrief));
  ledger.deleteMetadata(activeKey(spaceId));
  return "Saved. I’ll use this to filter, plan, and propose work. Next: ask me for your first three automations.";
}
