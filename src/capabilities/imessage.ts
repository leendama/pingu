import { contact, poll, richlink } from "spectrum-ts";
import type { PinguPlugin } from "../plugins.js";
import { capabilityPlugin, stringArray, stringValue } from "../tools.js";

export function imessagePlugin(): PinguPlugin {
  return capabilityPlugin(
    { id: "imessage", name: "iMessage", description: "Reactions, polls, links, contact cards, voice, and group controls." },
    [
      {
        schema: {
          type: "function",
          name: "react_to_message",
          description: "React naturally to the current iMessage instead of writing a full reply when a tapback is enough.",
          strict: true,
          parameters: {
            type: "object",
            properties: { reaction: { type: "string", enum: ["love", "like", "dislike", "laugh", "emphasize", "question"] } },
            required: ["reaction"],
            additionalProperties: false,
          },
        },
        private: false,
        run: async (args, context) => {
          const reaction = stringValue(args.reaction);
          if (!reaction) throw new Error("Reaction is required.");
          await context.message.react(reaction);
          return { delivered: true, output: JSON.stringify({ reacted: true, reaction }) };
        },
      },
      {
        schema: {
          type: "function",
          name: "send_poll",
          description: "Send a native poll to the current iMessage conversation when the group or chat is asked to vote.",
          strict: true,
          parameters: {
            type: "object",
            properties: {
              title: { type: "string" },
              options: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 10 },
            },
            required: ["title", "options"],
            additionalProperties: false,
          },
        },
        private: false,
        run: async (args, context) => {
          const title = stringValue(args.title);
          const options = stringArray(args.options);
          if (!title || options.length < 2) throw new Error("A poll title and at least two options are required.");
          await context.space.send(poll(title, options));
          return { delivered: true, output: JSON.stringify({ sent: true, type: "poll", title, options }) };
        },
      },
      {
        schema: {
          type: "function",
          name: "send_rich_link",
          description: "Send a rich link preview in the current iMessage conversation.",
          strict: true,
          parameters: {
            type: "object",
            properties: { url: { type: "string" } },
            required: ["url"],
            additionalProperties: false,
          },
        },
        private: false,
        run: async (args, context) => {
          const url = stringValue(args.url);
          if (!url) throw new Error("URL is required.");
          await context.space.send(richlink(url));
          return { delivered: true, output: JSON.stringify({ sent: true, type: "rich_link", url }) };
        },
      },
      {
        schema: {
          type: "function",
          name: "send_contact_card",
          description: "Send a contact as a native contact card attachment in the current iMessage conversation.",
          strict: true,
          parameters: {
            type: "object",
            properties: {
              name: { type: "string" },
              phone: { type: ["string", "null"] },
              email: { type: ["string", "null"] },
              company: { type: ["string", "null"] },
            },
            required: ["name", "phone", "email", "company"],
            additionalProperties: false,
          },
        },
        private: false,
        run: async (args, context) => {
          const nameValue = stringValue(args.name);
          if (!nameValue) throw new Error("Contact name is required.");
          await context.space.send(contact({
            name: { formatted: nameValue },
            phones: stringValue(args.phone) ? [{ value: stringValue(args.phone)! }] : [],
            emails: stringValue(args.email) ? [{ value: stringValue(args.email)! }] : [],
            org: stringValue(args.company) ? { name: stringValue(args.company)! } : undefined,
          }));
          return { delivered: true, output: JSON.stringify({ sent: true, type: "contact", name: nameValue }) };
        },
      },
      {
        schema: {
          type: "function",
          name: "send_voice_reply",
          description: "Send a short spoken reply as an audio message when the user explicitly asks for one.",
          strict: true,
          parameters: {
            type: "object",
            properties: { text: { type: "string", maxLength: 4096 } },
            required: ["text"],
            additionalProperties: false,
          },
        },
        private: false,
        run: async (args, context) => {
          const text = stringValue(args.text);
          if (!text) throw new Error("Voice reply text is required.");
          await context.sendVoice(text);
          return { delivered: true, output: JSON.stringify({ sent: true, type: "voice" }) };
        },
      },
      {
        schema: {
          type: "function",
          name: "get_group_members",
          description: "List the members of the current iMessage group chat.",
          strict: true,
          parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
        },
        private: false,
        sideEffecting: false,
        groupOnly: true,
        run: async (_args, context) => ({
          output: JSON.stringify({ members: await context.space.getMembers() }),
        }),
      },
      {
        schema: {
          type: "function",
          name: "rename_group",
          description: "Rename the current iMessage group chat immediately when asked.",
          strict: true,
          parameters: {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
            additionalProperties: false,
          },
        },
        private: false,
        groupOnly: true,
        run: async (args, context) => {
          const groupName = stringValue(args.name);
          if (!groupName) throw new Error("Group name is required.");
          await context.space.rename(groupName);
          return { output: JSON.stringify({ renamed: true, name: groupName }) };
        },
      },
      {
        schema: {
          type: "function",
          name: "add_group_members",
          description: "Add phone numbers or email addresses to the current iMessage group chat.",
          strict: true,
          parameters: {
            type: "object",
            properties: { members: { type: "array", items: { type: "string" }, minItems: 1 } },
            required: ["members"],
            additionalProperties: false,
          },
        },
        private: false,
        groupOnly: true,
        run: async (args, context) => {
          const members = stringArray(args.members);
          if (members.length === 0) throw new Error("At least one member is required.");
          await context.space.add(members);
          return { output: JSON.stringify({ added: true, members }) };
        },
      },
      {
        schema: {
          type: "function",
          name: "remove_group_members",
          description: "Remove phone numbers or email addresses from the current iMessage group chat.",
          strict: true,
          parameters: {
            type: "object",
            properties: { members: { type: "array", items: { type: "string" }, minItems: 1 } },
            required: ["members"],
            additionalProperties: false,
          },
        },
        private: false,
        groupOnly: true,
        run: async (args, context) => {
          const members = stringArray(args.members);
          if (members.length === 0) throw new Error("At least one member is required.");
          await context.space.remove(members);
          return { output: JSON.stringify({ removed: true, members }) };
        },
      },
    ],
  );
}
