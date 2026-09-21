# Priority reviews (phase 7)

Priority reviews compare the next seven days of the primary Calendar and open owner commitments with one explicitly selected Obsidian priorities note. They produce at most two supported trade-offs, with optional suggestions and source links. They do not move events, create obligations, or send notifications.

## Source selection

In an owner direct message, name the vault-relative path of the note to use, for example `use priorities.md as my priorities source`. Pingu validates that it is a complete Markdown note inside the configured vault, then records the choice privately. The latest contents of that selected file are used on each fresh review. Selecting a new source or clearing it removes the previous cached review.

Search rankings, filenames, old conversations and general principles never automatically designate current priorities. If no source is selected, Pingu asks which note is current. A selected note may contain historical reflections or options: these are not automatically treated as current commitments. Oversized, unavailable or truncated sources stop the review rather than silently excluding material.

## Reviewing

Ask Pingu to `review my priorities` or use the direction-review workflow. The review reads current sources and caches its evidence privately. Calendar times are rendered in the configured timezone. Cancelled, declined and transparent events are excluded. All-day markers have unknown occupied hours. Commitments without deadlines or duration estimates retain that uncertainty. Other people's promises are not counted as the owner's work.

Every finding must quote both the selected priorities note and identified Calendar/commitment evidence. Citations are constructed from actual source records. A source being absent from Calendar does not prove neglect; a title about an unrelated topic does not prove conflict. Suggestions remain optional and may include consciously revising a limit. No work-over-personal-life ranking is assumed. Quotes are validated in code; their interpretation remains a model judgement.

The text is limited to two findings and 120 words. Identical inputs reuse the prior assessment. A changed source is read automatically, and a source change during generation prevents publishing the outdated assessment. More than 150 evidence records require a narrower manual review rather than silent truncation.

## Optional background refresh

`PINGU_PRIORITY_REVIEWS=true` refreshes private review state once per local day for owners with a selected source, checking every ten minutes. Failures back off for an hour and mark old results as potentially stale. No source means no model call. No automatic message is sent, including when no conflict is found. On-demand review can refresh within the same day. Cached review tools expose creation time, exact quotations and source links; the assistant must not present old results as current.

Private state lives in `priority-reviews.json`, participates in reset/forget handling and never belongs in the public repository. Browser actions, commitment reminders and notification preferences are independent settings.

## Validation

Regression tests cover source selection, vault boundaries, source changes, unsupported citations, word limits, local timezone rendering, unavailable sources, quiet daily polling, owner isolation and cached results. `npm run eval:priorities` uses neutral live-model fixtures for an explicit time-limit conflict, missing-calendar evidence, historical ambitions and source prompt injection. It reads no personal sources.

Phase 8 will add explicit feedback on relevance and notifications; this feature does not silently infer those preferences.
