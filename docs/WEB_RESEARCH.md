# Read-only web research

Owner direct messages can use `search_web` for public questions and `read_web_page` for a focused question about a public URL. For example: “look up the latest release notes and give me the two changes that matter” or “read this article and explain its strongest evidence”. Saved read-only workflows may include these tools; existing workflows retain their original permissions.

The OpenAI endpoint uses the configured model and existing client. Other compatible endpoints do not register these tools. A model that does not support hosted search returns an explicit unavailable result; there is no silent model substitution. No new key or dependency is required. Searches incur the provider's normal model and tool charges.

Each request sends only the model-generated public question, optional URL, and current UTC date. The research call receives no transcript, private file content, or local action tools. The assistant is instructed to omit private information from queries; this is an instruction, not an automatic privacy classifier. `store: false` is set. No arbitrary page is fetched by the local process.

The integration follows the [OpenAI web search API](https://developers.openai.com/api/docs/guides/tools-web-search). Provider citation annotations supply source titles and URLs. Results carry retrieval time, never an invented publication date. Page research requires a completed opening action and citation for the exact requested URL (ignoring fragments); redirects or canonical URL differences may return unavailable. This is provider-reported access, not independent HTTP or full-text verification. Search summaries are model-generated, not raw page contents.

Limits: two research requests per owner turn, two concurrent requests per plugin instance, four hosted tool calls requested per API response, 3,000 output tokens, a 45-second client timeout, and no SDK retries. The installed SDK omits the request-side type for `max_tool_calls`, so the request adds that field explicitly; unsupported providers fail closed. A client timeout does not guarantee that remote computation stops or that charges stop accruing.

Research output is untrusted. The existing registry prevents it from authorizing external writes in that turn. It remains available for supported read-only synthesis. Missing citations, incomplete responses, unavailable pages, and provider errors return an explicit limitation. Oversized results are rejected rather than separated from their citations.

## Evaluation status

Offline regression tests cover completed lookup/citation requirements, exact page evidence, URL validation, redacted provider errors, request bounds, guest/group isolation, workflow limits, and malicious-page write blocking. Date and conflict fixtures check evidence preservation; they do not demonstrate that a live model notices every stale or contradictory source.

Before treating research quality as validated, run live cases for: a dated primary-source announcement; conflicting public claims; a stale article requested as current; a blocked or missing URL; and an instruction-injection page. Check claim-to-source support, temporal accuracy, honesty about access, useful brevity, and absence of actions. Run `npm run eval:quality -- /absolute/path/report.json` for a paid, opt-in live smoke evaluation. See QUALITY_EVALUATION.md for its precise scope; passing smoke cases is not broad factual-accuracy validation.
