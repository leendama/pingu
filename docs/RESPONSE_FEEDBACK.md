# Response feedback (phase 8)

Pingu records explicit feedback against a specific delivered response. Ordinary generated owner-DM text and tracked proactive briefings/reminders supply feedback targets. Guests, groups, silence and read receipts do not establish preferences. Command acknowledgements, rich media and unconfirmed deliveries are not inferred targets.

The private feedback store keeps up to twenty recent targets (available for seven days), thirty explicit feedback records, response style and category pause settings. Tools expose the current settings and feedback for inspection. Owner removal/forget and the data reset include this state. It is runtime data, never public repository content.

## Meaning of feedback

- **Useful / not useful:** record the particular response and exact owner wording. Relevant past briefing examples can improve future explanations, but do not change email eligibility or mute a person/topic.
- **Too long:** make ordinary future explanations briefer, aiming for 35 words. Explicitly requested detail, complete email previews and information needed for accuracy remain intact. This is model guidance, not destructive text truncation.
- **Wrong:** record the issue, then investigate the relevant facts. Saving feedback is not a claim that the underlying problem was corrected.

The assistant resolves the target using the conversation and stored IDs, asking when ambiguous. Feedback writes require an exact excerpt of the owner's current direct message; quoted reply targets cannot authorize changes. Target IDs cannot cross owner chats. Repeated writes are idempotent.

Explicit style requests can choose brief/standard and casual/neutral. Casual means lowercase sentence openings and `u` in chat while preserving proper names, code, quotations and the requested tone of email drafts. A standard length setting reverses the brief preference.

## Reminder controls

Explicit pause/resume requests may affect meeting-goal prompts or commitment due reminders, one category at a time. Pausing is checked before the poller claims delivery. Ambiguous requests such as “stop these” require clarification. A pause does not alter events, commitments, email policy or separately scheduled reminders. Resuming cannot enable a feature disabled in runtime configuration; tools report its effective state.

## Corrected legacy learning

`ignore 1`, `not important 1` and `reject 1` dismiss only that proposal. They no longer create sender/category suppression rules. Legacy inferred dismissal rules are excluded from future judgement; records are preserved for audit. Editing one draft no longer teaches “the owner commonly edits drafts,” and marking one item done or deferred no longer creates a general preference.

Explicit `always surface` rules and new approval preference records are scoped to the owner chat. Existing shared historical-learning rules retain their prior scope. Explicit owner email-alert policy still takes precedence. Recording feedback after successful delivery cannot convert success into an action failure or trigger a resend.

## Validation

Regression tests cover explicit quotation, target age, replay, owner isolation, pause/resume effectiveness, delivery-observer failures, scoped rules and the former “ignore one, suppress future sender mail” behaviour. `npm run eval:feedback` uses temporary neutral data to test tool routing for explicit brevity feedback, quoted text that is not feedback and an ambiguous pause request. It does not modify real feedback settings or send messages.
