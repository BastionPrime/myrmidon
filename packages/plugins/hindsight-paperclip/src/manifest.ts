import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

/**
 * Local fork of the upstream hindsight memory plugin.
 *
 * Same plugin id as the upstream package on purpose: this fork replaces the
 * npm package on instances that need per-agent bank routing (memory
 * isolation), and a distinct id would leave the upstream installed alongside.
 */

const PLUGIN_ID = "paperclip-plugin-hindsight";
const PLUGIN_VERSION = "0.3.0-myrmidon.1";

const BANK_RESOLUTION_DESCRIPTION = [
  "Memory bank routing. Per agent, in order:",
  "(1) adapterConfig.hindsight.bankId on the agent card;",
  "(2) bankByAgentId in this plugin's configuration.",
  "An agent resolved by neither is closed: retain is skipped with a warning and recall returns nothing.",
  "There is no fallback to a shared bank.",
].join(" ");

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Hindsight Memory",
  author: "Vectorize <support@vectorize.io>",
  description:
    "Persistent long-term memory for Paperclip agents. Automatically recalls relevant context before each run and retains agent output after — so every agent gets smarter over time.",
  categories: ["automation"],
  capabilities: [
    "events.subscribe",
    "agent.tools.register",
    "plugin.state.read",
    "plugin.state.write",
    "http.outbound",
    "secrets.read-ref",
    "agents.read",
    "issues.read",
    "issue.comments.read",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    required: ["hindsightApiUrl"],
    properties: {
      hindsightApiUrl: {
        type: "string",
        title: "Hindsight API URL",
        description: "Base URL of your Hindsight instance. Defaults to Hindsight Cloud. Use http://localhost:8888 for self-hosted.",
        default: "https://api.hindsight.vectorize.io",
      },
      hindsightApiKeyRef: {
        type: "string",
        title: "Hindsight API Key (secret ref)",
        description: "Name of the Paperclip secret holding your Hindsight Cloud API key. Leave empty for self-hosted.",
      },
      recallBudget: {
        type: "string",
        title: "Recall Budget",
        description: "'low' is fastest, 'mid' balances speed and depth, 'high' is most thorough.",
        enum: ["low", "mid", "high"],
        default: "mid",
      },
      autoRetain: {
        type: "boolean",
        title: "Auto-retain Comments",
        description: "Automatically retain ticket comments to Hindsight as they are created.",
        default: true,
      },
      bankByAgentId: {
        type: "object",
        title: "Agent → Bank Map",
        description:
          "Bank ID per agent card UUID; the fallback when an agent card has no adapterConfig.hindsight.bankId. Agents resolved by neither source are closed (no retain, empty recall). Keep this map synchronized from the agent cards.",
        additionalProperties: { type: "string" },
      },
      enabledAgentIds: {
        type: "array",
        title: "Enabled Agent IDs",
        description: "Restrict Hindsight recall/retain to these agent IDs only. Leave empty to enable for all agents (default).",
        items: { type: "string" },
      },
    },
  },
  tools: [
    {
      name: "hindsight_recall",
      displayName: "Recall from Memory",
      description:
        "Search Hindsight long-term memory for context relevant to a query. Use this before starting a task to surface relevant past decisions, preferences, and knowledge.",
      parametersSchema: {
        type: "object",
        required: ["query"],
        properties: {
          query: {
            type: "string",
            description: "What to search for in memory",
          },
        },
      },
    },
    {
      name: "hindsight_retain",
      displayName: "Save to Memory",
      description:
        "Store important facts, decisions, or outcomes in Hindsight long-term memory for future runs.",
      parametersSchema: {
        type: "object",
        required: ["content"],
        properties: {
          content: {
            type: "string",
            description: "The content to store in memory",
          },
        },
      },
    },
  ],
};

export const BANK_RESOLUTION_RULES = BANK_RESOLUTION_DESCRIPTION;

export default manifest;
