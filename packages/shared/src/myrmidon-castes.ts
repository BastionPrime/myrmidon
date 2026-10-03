// packages/shared/src/myrmidon-castes.ts
//
// myrmidon(1.6.1 CUSTOM-CASTES): the company caste (agent role) directory
// contract — view shape, POST/PATCH/DELETE bodies, and the 12 built-in seed
// castes derived from AGENT_ROLES.
//
// Pure data and pure functions only. The server, the UI and the tests read one
// source of truth:
//
//  - CasteView: what one caste row looks like to the API. `key` is the stable
//    identifier that matches `agents.role` (latin letters, digits, hyphen,
//    1-60 chars); it is immutable after creation.
//  - create/patch/delete zod schemas: the request bodies of the settings API.
//  - MYRMIDON_CASTE_SEED: the 12 built-in castes every company starts from
//    (keys = AGENT_ROLES, labels = AGENT_ROLE_LABELS, swarmEligible = true,
//    maxActiveTasks = null = the global swarm limit).
//
// The directory is read fresh from the database on every call — no process
// cache, no env — so create/assign/delete are visible to the swarm without a
// server restart (owner's liveness criterion). The only in-process cache the
// store may keep is a seed MISS cache (which companies were already seeded),
// never a read cache.

import { z } from "zod";
import { AGENT_ROLE_LABELS, AGENT_ROLES, type AgentRole } from "./constants.js";

/**
 * Valid caste key: the stable identifier that matches `agents.role`.
 * Latin letters, digits, hyphen and underscore; 1-60 chars.
 */
export const CASTE_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,59}$/;

/** The color layer of the caste badge: token vars of the status color set. */
export const CASTE_COLORS = [
  "primary",
  "muted",
  "blue",
  "amber",
  "green",
  "violet",
  "red",
  "gray",
] as const;
export type CasteColor = (typeof CASTE_COLORS)[number];

/** POST /castes body. No `key` here — the key IS the URL field the caller
 *  sends as `key` on create and can never change afterwards. */
export const createCasteSchema = z.object({
  key: z.string().trim().toLowerCase().regex(CASTE_KEY_PATTERN, {
    message:
      "caste key must be 1-60 chars of lowercase latin letters, digits, hyphens or underscores",
  }),
  nameEn: z.string().trim().min(1).max(160),
  nameRu: z.string().trim().max(160).optional().nullable(),
  description: z.string().trim().max(2000).optional().nullable(),
  color: z.enum(CASTE_COLORS).optional(),
  icon: z.string().trim().min(1).max(64).optional().nullable(),
  defaultModel: z.string().trim().min(1).max(512).optional().nullable(),
  swarmEligible: z.boolean().optional(),
  maxActiveTasks: z.number().int().min(1).max(1000).optional().nullable(),
});
export type CreateCasteInput = z.infer<typeof createCasteSchema>;

/** PATCH /castes/{key} body: every mutable field except `key` and `builtIn`. */
export const patchCasteSchema = z.object({
  nameEn: z.string().trim().min(1).max(160).optional(),
  nameRu: z.string().trim().max(160).optional().nullable(),
  description: z.string().trim().max(2000).optional().nullable(),
  color: z.enum(CASTE_COLORS).optional(),
  icon: z.string().trim().min(1).max(64).optional().nullable(),
  defaultModel: z.string().trim().min(1).max(512).optional().nullable(),
  swarmEligible: z.boolean().optional(),
  maxActiveTasks: z.number().int().min(1).max(1000).optional().nullable(),
});
export type PatchCasteInput = z.infer<typeof patchCasteSchema>;

/** DELETE /castes/{key} body (optional): where the caste's agents move. */
export const deleteCasteSchema = z.object({
  reassignTo: z.string().trim().toLowerCase().regex(CASTE_KEY_PATTERN, {
    message:
      "reassignTo must be 1-60 chars of lowercase latin letters, digits, hyphens or underscores",
  }).optional(),
});
export type DeleteCasteInput = z.infer<typeof deleteCasteSchema>;

/** One caste row as the API answers it. */
export interface CasteView {
  key: string;
  nameEn: string;
  nameRu: string | null;
  description: string | null;
  color: string;
  icon: string | null;
  defaultModel: string | null;
  swarmEligible: boolean;
  maxActiveTasks: number | null;
  builtIn: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * The 12 built-in castes a company is seeded with on first read: the AGENT_ROLES
 * keys with their labels, swarm-eligible, no per-caste active-task ceiling
 * (null = the global swarm limit). Idempotent: seeding inserts only the keys
 * the company is still missing.
 */
export const MYRMIDON_CASTE_SEED: ReadonlyArray<{
  key: AgentRole;
  nameEn: string;
  nameRu: string;
  color: CasteColor;
}> = AGENT_ROLES.map((key) => {
  const label = AGENT_ROLE_LABELS[key];
  return { key, nameEn: label, nameRu: label, color: casteSeedColor(key) });
});

/** Evenly spread seed colors over the token palette (deterministic). */
function casteSeedColor(key: AgentRole): CasteColor {
  const order: Record<AgentRole, number> = {
    ceo: 0,
    cto: 1,
    cmo: 2,
    cfo: 3,
    security: 4,
    engineer: 5,
    designer: 6,
    pm: 7,
    qa: 8,
    devops: 9,
    researcher: 10,
    general: 11,
  };
  const palette: CasteColor[] = [
    "violet",
    "blue",
    "amber",
    "green",
    "red",
    "primary",
    "gray",
    "muted",
  ];
  return palette[order[key] % palette.length]!;
}
