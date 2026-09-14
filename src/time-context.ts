/** Runtime-owned temporal facts. Never infer today's date from conversation history. */
export function liveTime(timezone: string, now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now).map((part) => [part.type, part.value]));
  return {
    timezone,
    local_date: `${parts.year}-${parts.month}-${parts.day}`,
    local_time: new Intl.DateTimeFormat("en-AU", {
      timeZone: timezone, dateStyle: "full", timeStyle: "long", hour12: true,
    }).format(now),
    iso_utc: now.toISOString(),
    unix_time_ms: now.getTime(),
  };
}

export function temporalInstructions(timezone: string, now = new Date()): string {
  return `Live runtime clock for this model request: ${JSON.stringify(liveTime(timezone, now))}\nThis supersedes all earlier clock results and assistant statements about today's date. Resolve new relative dates in this timezone. Preserve the date of an active request when a follow-up only supplies its time or duration; never silently roll a requested past time forward. For delayed follow-ups spanning midnight, clarify which date if the original date cannot be established.`;
}
