// myrmidon(CLOUD-CONNECTOR): shared contracts of the cloud storage connector.
//
// The board owns one owner-authorized account per cloud provider and hands
// agents access to folders inside it. These types are the wire contract
// between the API, the UI and the agent-facing tools; the enforcement lives
// in server/src/myrmidon/cloud-connector/. English-only copy, neutral test
// data only: no internal addresses, hosts or agent names.

import { z } from "zod";

/** Providers the connector knows how to talk to. Adding one is a registry entry. */
export const CLOUD_PROVIDER_IDS = ["onedrive", "google-drive", "yandex-disk"] as const;
export type CloudProviderId = (typeof CLOUD_PROVIDER_IDS)[number];

export const CLOUD_ACCESS_MODES = ["ro", "rw"] as const;
export type CloudAccessMode = (typeof CLOUD_ACCESS_MODES)[number];

/** `own` — a folder in the connector account's own drive; `shared` — a folder
 * somebody shared with the connector account (always read only for us). */
export const CLOUD_ROOT_KINDS = ["own", "shared"] as const;
export type CloudRootKind = (typeof CLOUD_ROOT_KINDS)[number];

export type CloudGrantTargetKind = "agent" | "caste" | "all";

export interface CloudAccount {
  id: string;
  providerId: CloudProviderId;
  displayName: string;
  /** Company the owner connected the account for; null for accounts made before part B. */
  companyId: string | null;
  /** Id of the connector-owned company secret that holds the token bundle. Never the token itself. */
  tokenRef: string;
  scopes: string[];
  connectedAt: string;
  connectedBy: string;
}

export interface CloudRoot {
  id: string;
  providerId: CloudProviderId;
  /** Company that owns the account this folder lives in; null for roots made before part B. */
  companyId: string | null;
  /** Stable slug the owner sees and agents address: `[a-z0-9-]`, unique per provider. */
  name: string;
  kind: CloudRootKind;
  description: string;
  /** Shared roots address a drive + item; own roots address a folder path in the account drive. */
  driveId: string | null;
  itemId: string | null;
  folder: string | null;
  /** Personal roots are created and granted automatically per agent. */
  personalForAgentId: string | null;
  createdAt: string;
}

export interface CloudGrant {
  id: string;
  rootId: string;
  targetKind: CloudGrantTargetKind;
  /** Set for `agent` targets. */
  agentId: string | null;
  /** Set for `caste` targets. */
  caste: string | null;
  mode: CloudAccessMode;
  createdAt: string;
  createdBy: string;
}

/** What a single agent may reach: the roots it was granted and the effective mode. */
export interface CloudResolvedAccess {
  root: CloudRoot;
  mode: CloudAccessMode;
  via: CloudGrantTargetKind;
}

export interface CloudJournalEntry {
  id: string;
  at: string;
  /** Agent id, or the board user id for owner actions. */
  actor: string;
  tool: string;
  rootId: string | null;
  rootName: string | null;
  path: string | null;
  ok: boolean;
  /** Short, agent-readable outcome; never file contents. */
  detail: string | null;
}

export const cloudProviderIdSchema = z.enum(CLOUD_PROVIDER_IDS);
export const cloudAccessModeSchema = z.enum(CLOUD_ACCESS_MODES);
export const cloudRootKindSchema = z.enum(CLOUD_ROOT_KINDS);

/** Owner starts an OAuth connect: the connector answers with the provider URL to open. */
export const cloudConnectStartSchema = z.object({
  companyId: z.string().trim().min(1).max(120),
  displayName: z.string().trim().min(1).max(120).optional(),
});

export const cloudConnectStartResponseSchema = z.object({
  providerId: cloudProviderIdSchema,
  authorizeUrl: z.string().url(),
  state: z.string().min(1),
});

/** What the callback answers: the connected account, never a token. */
export interface CloudConnectResult {
  account: CloudAccount;
}

export const cloudRootCreateSchema = z
  .object({
    providerId: cloudProviderIdSchema,
    companyId: z.string().trim().min(1).max(120),
    name: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9-]{0,60}$/, "name: lowercase letters, digits and hyphens"),
    kind: cloudRootKindSchema,
    description: z.string().trim().max(200).optional(),
    driveId: z.string().trim().min(1).max(200).optional(),
    itemId: z.string().trim().min(1).max(200).optional(),
    folder: z.string().trim().min(1).max(400).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.kind === "shared" && (!value.driveId || !value.itemId)) {
      ctx.addIssue({ code: "custom", message: "a shared root needs driveId and itemId", path: ["driveId"] });
    }
    if (value.kind === "own" && !value.folder) {
      ctx.addIssue({ code: "custom", message: "an own root needs a folder", path: ["folder"] });
    }
  });

export const cloudGrantPutSchema = z
  .object({
    rootId: z.string().trim().min(1).max(120),
    targetKind: z.enum(["agent", "caste", "all"]),
    agentId: z.string().trim().min(1).max(120).optional(),
    caste: z.string().trim().min(1).max(60).optional(),
    mode: cloudAccessModeSchema,
  })
  .superRefine((value, ctx) => {
    if (value.targetKind === "agent" && !value.agentId) {
      ctx.addIssue({ code: "custom", message: "an agent grant needs agentId", path: ["agentId"] });
    }
    if (value.targetKind === "caste" && !value.caste) {
      ctx.addIssue({ code: "custom", message: "a caste grant needs caste", path: ["caste"] });
    }
  });

/** The tool names agents see through the tool gateway. */
export const CLOUD_TOOL_NAMES = [
  "cloud_list",
  "cloud_search",
  "cloud_read",
  "cloud_download",
  "cloud_upload",
  "cloud_move",
] as const;
export type CloudToolName = (typeof CLOUD_TOOL_NAMES)[number];

/**
 * The root name an agent may always use: it stands for that agent's own folder.
 * The connector creates the folder on first use and grants it read-write to
 * that agent only, so an agent can rely on one stable name it does not have to
 * be told. Reserved: the owner cannot create a root with this slug.
 */
export const CLOUD_PERSONAL_ROOT_ALIAS = "personal";

export const cloudToolCallSchema = z.object({
  tool: z.enum(CLOUD_TOOL_NAMES),
  root: z.string().trim().min(1).max(120),
  path: z.string().max(2000).optional(),
  query: z.string().trim().min(1).max(200).optional(),
  toRoot: z.string().trim().min(1).max(120).optional(),
  toPath: z.string().max(2000).optional(),
  contentBase64: z.string().max(6_000_000).optional(),
  overwrite: z.boolean().optional(),
});

export type CloudToolCall = z.infer<typeof cloudToolCallSchema>;

export interface CloudToolResult {
  ok: boolean;
  tool: CloudToolName;
  root: string;
  path: string;
  /** Present on success; free-form per tool. */
  result?: unknown;
  /** Present on refusal: short and explicit about the boundary. */
  error?: string;
}