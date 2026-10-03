// server/src/myrmidon/wiki-cortex/service.ts
//
// myrmidon(1.6-WIKI): the regulation lifecycle and the resolver the delivery
// path reads.
//
// The lifecycle is deliberately one-way in the direction that matters: writing
// text never changes what the fleet reads. An edit — of a draft or of an
// approved regulation — appends a DRAFT revision, and the resolver keeps
// answering with the newest APPROVED revision until somebody approves the new
// text. A rollback is one more revision copying an earlier one, so history
// stays append-only and the restore is itself restorable.
//
// The service knows nothing about the database: the store is injected, so the
// tests run the real logic against an in-memory store and the routes stay free
// of `@paperclipai/db`.

import { randomUUID } from "node:crypto";
import { badRequest, notFound, unprocessable } from "../../errors.js";
import { ANY_ROLE, type ApprovedRegulation, type RegulationActor, type RegulationPageRecord, type RegulationRevisionRecord, type RegulationStatus } from "./types.js";

/** Everything the service needs from persistence. */
export interface RegulationStore {
  /** Every regulation of one company, in any order. */
  list(companyId: string): Promise<RegulationPageRecord[]>;
  get(companyId: string, slug: string): Promise<RegulationPageRecord | null>;
  /** Insert-or-replace a whole page row. */
  put(page: RegulationPageRecord): Promise<RegulationPageRecord>;
}

export interface SaveRegulationInput {
  slug: string;
  title: string;
  roles?: string[];
  content: string;
  changeSummary?: string | null;
  actor?: RegulationActor;
}

export interface RegulationServiceOptions {
  now?: () => Date;
  /** Ids of newly created pages; injected so tests stay deterministic. */
  newId?: () => string;
}

/** Slugs address a page in a URL and in a run's log, so they stay narrow. */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9._/-]{0,127}$/;

export function normalizeRegulationSlug(raw: string): string {
  const slug = raw.trim().toLowerCase();
  if (!SLUG_PATTERN.test(slug)) {
    throw badRequest(
      "regulation slug must be lowercase latin letters, digits, dot, dash, underscore or slash (for example deploy/oncall)",
    );
  }
  if (slug.endsWith("/") || slug.includes("//")) {
    throw badRequest("regulation slug must not end with a slash or contain an empty segment");
  }
  return slug;
}

/** Role keys are compared verbatim; the list is deduplicated and never empty. */
export function normalizeRegulationRoles(raw: readonly string[] | undefined): string[] {
  const roles = [...new Set((raw ?? []).map((role) => role.trim()).filter((role) => role.length > 0))];
  if (roles.length === 0) return [ANY_ROLE];
  return roles.sort();
}

function requireText(value: string | undefined, field: string): string {
  const text = (value ?? "").trim();
  if (text.length === 0) throw badRequest(`regulation ${field} must not be empty`);
  return text;
}

/** The revision the resolver reads: the newest one that was approved. */
export function deliveredRevision(page: RegulationPageRecord): RegulationRevisionRecord | null {
  let best: RegulationRevisionRecord | null = null;
  for (const revision of page.revisions) {
    if (revision.status !== "approved") continue;
    if (!best || revision.revisionNumber > best.revisionNumber) best = revision;
  }
  return best;
}

function appliesToRole(roles: readonly string[], role: string): boolean {
  return roles.includes(ANY_ROLE) || roles.includes(role);
}

function revisionAt(page: RegulationPageRecord, revisionNumber: number): RegulationRevisionRecord | null {
  return page.revisions.find((revision) => revision.revisionNumber === revisionNumber) ?? null;
}

function actorFields(actor: RegulationActor | undefined): { createdByAgentId: string | null; createdByUserId: string | null } {
  return {
    createdByAgentId: actor?.agentId ?? null,
    createdByUserId: actor?.userId ?? null,
  };
}

function nextRevision(
  page: RegulationPageRecord,
  input: { title: string; roles: string[]; content: string; status: RegulationStatus; changeSummary: string | null; actor?: RegulationActor },
  createdAt: string,
): RegulationRevisionRecord {
  return {
    revisionNumber: page.revisionNumber + 1,
    title: input.title,
    roles: input.roles,
    content: input.content,
    status: input.status,
    changeSummary: input.changeSummary,
    ...actorFields(input.actor),
    createdAt,
  };
}

/** Applies a revision to the page's current mirrors. */
function withRevision(page: RegulationPageRecord, revision: RegulationRevisionRecord, updatedAt: Date): RegulationPageRecord {
  return {
    ...page,
    title: revision.title,
    roles: revision.roles,
    status: revision.status,
    revisionNumber: revision.revisionNumber,
    content: revision.content,
    revisions: [...page.revisions, revision],
    updatedAt,
  };
}

export function createWikiRegulationService(store: RegulationStore, options: RegulationServiceOptions = {}) {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => randomUUID());

  return {
    list(companyId: string): Promise<RegulationPageRecord[]> {
      return store.list(companyId);
    },

    get(companyId: string, slug: string): Promise<RegulationPageRecord | null> {
      return store.get(companyId, normalizeRegulationSlug(slug));
    },

    /**
     * Creates a page as a draft, or appends a draft revision to an existing one.
     * A page that was approved therefore stops being delivered the moment it is
     * edited, until an approval makes the new text the delivered one.
     */
    async save(companyId: string, input: SaveRegulationInput): Promise<RegulationPageRecord> {
      const slug = normalizeRegulationSlug(input.slug);
      const title = requireText(input.title, "title");
      const content = requireText(input.content, "content");
      const roles = normalizeRegulationRoles(input.roles);
      const existing = await store.get(companyId, slug);
      const at = now();
      if (!existing) {
        const revision: RegulationRevisionRecord = {
          revisionNumber: 1,
          title,
          roles,
          content,
          status: "draft",
          changeSummary: input.changeSummary ?? null,
          ...actorFields(input.actor),
          createdAt: at.toISOString(),
        };
        return store.put({
          id: newId(),
          companyId,
          slug,
          title,
          roles,
          status: revision.status,
          revisionNumber: 1,
          content,
          revisions: [revision],
          createdAt: at,
          updatedAt: at,
        });
      }
      return store.put(
        withRevision(
          existing,
          nextRevision(existing, { title, roles, content, status: "draft", changeSummary: input.changeSummary ?? null, actor: input.actor }, at.toISOString()),
          at,
        ),
      );
    },

    /**
     * Approves the newest revision — the only way text becomes delivered. An
     * approval of an already approved page is a no-op, so a repeated click does
     * not append an empty revision.
     */
    async approve(companyId: string, slug: string, actor?: RegulationActor): Promise<RegulationPageRecord> {
      const page = await store.get(companyId, normalizeRegulationSlug(slug));
      if (!page) throw notFound(`Regulation not found: ${slug}`);
      const current = revisionAt(page, page.revisionNumber);
      if (!current) throw unprocessable(`Regulation ${page.slug} has no revision ${page.revisionNumber}`);
      if (current.status === "approved") return page;
      const at = now();
      const approved: RegulationRevisionRecord = { ...current, status: "approved", ...actorFields(actor) };
      return store.put(
        withRevision(
          { ...page, revisions: page.revisions.filter((revision) => revision.revisionNumber !== approved.revisionNumber) },
          approved,
          at,
        ),
      );
    },

    /**
     * Restores an earlier revision as a new one. The new revision keeps the
     * restored revision's status: rolling back to an approved text therefore
     * restores what the fleet reads immediately, and the rollback itself can be
     * rolled back.
     */
    async rollback(companyId: string, slug: string, revisionNumber: number, actor?: RegulationActor): Promise<RegulationPageRecord> {
      const page = await store.get(companyId, normalizeRegulationSlug(slug));
      if (!page) throw notFound(`Regulation not found: ${slug}`);
      const target = revisionAt(page, revisionNumber);
      if (!target) throw notFound(`Regulation ${page.slug} has no revision ${revisionNumber}`);
      const at = now();
      return store.put(
        withRevision(
          page,
          nextRevision(
            page,
            {
              title: target.title,
              roles: target.roles,
              content: target.content,
              status: target.status,
              changeSummary: `rolled back to revision ${target.revisionNumber}`,
              actor,
            },
            at.toISOString(),
          ),
          at,
        ),
      );
    },

    /**
     * The contract of the delivery path: every approved regulation that applies
     * to `role`, with the revision the text came from.
     */
    async resolved(companyId: string, role: string): Promise<ApprovedRegulation[]> {
      const pages = await store.list(companyId);
      const out: ApprovedRegulation[] = [];
      for (const page of pages) {
        const revision = deliveredRevision(page);
        if (!revision) continue;
        if (!appliesToRole(revision.roles, role)) continue;
        out.push({
          pageId: page.id,
          slug: page.slug,
          title: revision.title,
          content: revision.content,
          version: revision.revisionNumber,
          roles: revision.roles,
        });
      }
      out.sort((left, right) => (left.slug < right.slug ? -1 : left.slug > right.slug ? 1 : 0));
      return out;
    },
  };
}

export type WikiRegulationService = ReturnType<typeof createWikiRegulationService>;