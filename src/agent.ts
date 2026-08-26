import { imessage } from "@spectrum-ts/imessage";
import OpenAI from "openai";
import type { Response, ResponseInput } from "openai/resources/responses/responses";
import { markdown, Spectrum } from "spectrum-ts";
import type { Message, Space } from "spectrum-ts";
import { builtInPlugins } from "./builtin-plugin.js";
import { loadCommunityPlugins } from "./community-plugins.js";
import { clearConversationId, getConversationId, setConversationId } from "./conversations.js";
import { createMessageProcessor, inboundMessageText } from "./message-pipeline.js";
import { consumePendingEmailConfirmation, getPendingEmail, markPendingEmailReviewed } from "./pending-emails.js";
import { emailAlertStore, startEmailAlertScheduler } from "./email-alerts.js";
import { googleGmailPort } from "./google.js";
import { PluginRegistry, type ToolRunContext } from "./plugins.js";
import { startReminderScheduler } from "./reminders.js";
import type { RuntimeSettings } from "./runtime-settings.js";
import { KeyedBatchQueue } from "./task-queue.js";
import { resetAttemptOutputs } from "./turn-state.js";

class IncompleteResponseError extends Error {
  constructor(readonly reason: string | undefined) {
    super(`OpenAI returned an incomplete response${reason ? ` (${reason})` : ""}.`);
    this.name = "IncompleteResponseError";
  }
}

export function agentInstructions(settings: RuntimeSettings, pluginInstructions: string[]): string {
  return [
    `You are ${settings.assistantName}, ${settings.ownerName}'s capable mate on iMessage. Sound casual, punchy, spontaneous, and high-energy.`,
    "Use the fewest words possible while preserving the result. Default to one short sentence or fragment, often 2 to 12 words. Skip greetings, preambles, recaps, headings, lists, filler, and offers to help unless they are essential.",
    "Use contractions and everyday language. Light humour and an occasional exclamation are welcome. Avoid corporate language, forced slang, repeated catchphrases, overusing the owner's name, and claims of human experience.",
    "Help the owner think, plan, prioritise, learn technical foundations, and take clear next actions in natural prose.",
    "Use tools whenever an answer depends on current calendar events, email, meeting notes, or the current time. Never invent tool results.",
    "Always call get_current_time before answering about the current time or date, or resolving relative dates such as today, tomorrow, yesterday, or this week.",
    "Every email requires confirmation before sending. Create a Gmail draft, show the full recipients, subject, and body, then ask for confirmation. Send only after the next message explicitly confirms the reviewed draft.",
    "You can create persistent Gmail sender alerts that text the current chat when new matching email arrives. Search Gmail when useful. If a person's first name and company domain are clear, infer firstname@company-domain and create the alert immediately, then state the inferred address briefly.",
    "If another request follows a draft review, use review_gmail_draft to show the complete draft again. Every changed draft needs a fresh confirmation.",
    "Perform clear calendar moves, creations, edits, and deletions in the same turn. Search first when needed. Ask one focused question when the event or requested change is unclear.",
    "Private Gmail, Calendar, and Granola tools stay unavailable in group chats. Keep private account information out of groups.",
    "Create clear reminders immediately. Use a reaction as the complete response when it fits. Send voice replies when asked.",
    "Granola editing is currently unavailable. Say this plainly when asked.",
    `Interpret dates and times in ${settings.timezone} unless the owner gives another timezone.`,
    "Answer with only the outcome or the one necessary question. Give detail only when requested or required for safety. Email draft reviews must still show every recipient, the subject, and the full body.",
    "When the user sends consecutive labelled messages, preserve their order and complete every request or detail they contain.",
    ...pluginInstructions,
  ].join("\n");
}

export interface RunningAgent {
  done: Promise<void>;
  stop(): Promise<void>;
}

export function mayReplayResponseFailure(input: {
  status?: number;
  incomplete: boolean;
  sideEffectAttempted: boolean;
}): boolean {
  return !input.sideEffectAttempted && (input.status === 400 || input.status === 404 || input.incomplete);
}

export async function startAgent(settings: RuntimeSettings): Promise<RunningAgent> {
  const openai = new OpenAI({ apiKey: settings.openaiApiKey });
  const registry = new PluginRegistry([...builtInPlugins(settings), ...await loadCommunityPlugins()]);
  const instructions = agentInstructions(settings, registry.instructions);

  async function createConversation(spaceId: string): Promise<string> {
    const conversation = await openai.conversations.create({ metadata: { spectrum_space_id: spaceId } });
    await setConversationId(spaceId, conversation.id);
    return conversation.id;
  }

  async function runResponse(
    conversationId: string,
    input: ResponseInput | string,
    context: ToolRunContext,
  ): Promise<Response> {
    let response = await openai.responses.create({
      model: settings.model,
      conversation: conversationId,
      instructions,
      input,
      tools: registry.tools,
      reasoning: { effort: "low" },
      text: { verbosity: "low" },
    });
    for (let round = 0; round < 6; round += 1) {
      const calls = response.output.filter((item) => item.type === "function_call");
      if (calls.length === 0) return response;
      const outputs: ResponseInput = [];
      for (const call of calls) {
        const result = await registry.run(call.name, call.arguments, context);
        outputs.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: result.handled ? result.output : JSON.stringify({ error: `Unknown tool: ${call.name}` }),
        });
      }
      response = await openai.responses.create({
        model: settings.model,
        conversation: conversationId,
        instructions,
        input: outputs,
        tools: registry.tools,
        reasoning: { effort: "low" },
        text: { verbosity: "low" },
      });
    }
    throw new Error("The agent exceeded the tool-call limit.");
  }

  async function generateReply(spaceId: string, inboundText: string, context: ToolRunContext): Promise<string> {
    let conversationId = await getConversationId(spaceId) ?? await createConversation(spaceId);
    try {
      const response = await runResponse(conversationId, inboundText, context);
      if (response.output_text) return response.output_text;
      if (response.status === "incomplete") throw new IncompleteResponseError(response.incomplete_details?.reason);
      throw new Error(`OpenAI returned no reply (status: ${response.status}).`);
    } catch (error) {
      const status = error instanceof OpenAI.APIError ? error.status : undefined;
      if (!mayReplayResponseFailure({
        status,
        incomplete: error instanceof IncompleteResponseError,
        sideEffectAttempted: context.sideEffectAttempted,
      })) throw error;
      resetAttemptOutputs(context);
      await clearConversationId(spaceId);
      conversationId = await createConversation(spaceId);
      const response = await runResponse(conversationId, inboundText, context);
      if (response.output_text) return response.output_text;
      if (response.status === "incomplete") throw new IncompleteResponseError(response.incomplete_details?.reason);
      throw new Error(`OpenAI returned no reply after resetting conversation (status: ${response.status}).`);
    }
  }

  const app = await Spectrum({
    projectId: settings.photonProjectId,
    projectSecret: settings.photonProjectSecret,
    providers: [imessage.config()],
    telemetry: true,
  });
  const imessagePlatform = imessage(app);
  const stopReminders = startReminderScheduler(async (reminder) => {
    const space = await imessagePlatform.space.get(reminder.spaceId);
    if (!space) throw new Error("The reminder's iMessage conversation is unavailable.");
    await space.send(markdown(`⏰ ${reminder.text}`));
    console.log("Reminder delivered:", { reminderId: reminder.id });
  });
  const alertGmail = googleGmailPort(settings.google);
  const stopEmailAlerts = startEmailAlertScheduler(
    emailAlertStore,
    (query, maxResults) => alertGmail.searchMessages(query, maxResults),
    async (alert, email) => {
      const space = await imessagePlatform.space.get(alert.spaceId);
      if (!space) throw new Error("The email alert's iMessage conversation is unavailable.");
      const sender = alert.label || email.from || alert.gmailQuery;
      const subject = email.subject || "(no subject)";
      const preview = email.snippet ? `\n${email.snippet}` : "";
      await space.send(markdown(`📬 New email from ${sender}\n${subject}${preview}`));
      console.log("Email alert delivered:", { alertId: alert.id, messageId: email.id });
    },
  );

  const processMessage = createMessageProcessor({
    assistantName: settings.assistantName,
    timezone: settings.timezone,
    generateReply,
    consumeEmailConfirmation: consumePendingEmailConfirmation,
    getPendingEmail,
    markEmailReviewed: markPendingEmailReviewed,
    synthesizeVoice: async (text) => {
      const speech = await openai.audio.speech.create({
        model: "gpt-4o-mini-tts",
        voice: "coral",
        input: text,
        instructions: "Speak warmly and casually, like a thoughtful mate. Keep the delivery natural and unforced.",
        response_format: "aac",
      });
      return Buffer.from(await speech.arrayBuffer());
    },
  });

  console.log(`${settings.assistantName} is connected and awaiting iMessages.`, { model: settings.model });
  const messageQueue = new KeyedBatchQueue<{ space: Space; message: Message }>(1_500, async (_spaceId, entries) => {
    const latest = entries.at(-1);
    if (!latest) return;
    await processMessage(latest.space, entries.map((entry) => entry.message));
  });
  let stopping = false;
  const done = (async () => {
    try {
      for await (const [space, message] of app.messages) {
        if (!inboundMessageText(message)) continue;
        void messageQueue.push(space.id, { space, message }).catch((error) => {
          console.error("Message task stopped unexpectedly:", error instanceof Error ? error.message : String(error));
        });
      }
      if (!stopping) throw new Error("The Spectrum message stream ended unexpectedly.");
    } finally {
      stopReminders();
      stopEmailAlerts();
      await messageQueue.drain();
    }
  })();

  return {
    done,
    stop: async () => {
      stopping = true;
      stopReminders();
      stopEmailAlerts();
      await app.stop();
      await done;
    },
  };
}
