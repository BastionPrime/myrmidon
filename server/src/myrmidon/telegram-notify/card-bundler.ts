// myrmidon(1.6-TG-PROACTIVITY-E): bundling of U2 owner decision cards.
//
// Point 5 of the epic: the U2 approval/question cards keep arriving — they
// are owner decisions — but several cards delivered inside one bundling
// window (5 minutes by default) become ONE summary publication in the owner's
// standing Telegram DM instead of one provider message per card. Every card
// stays individually visible and individually answerable in the summary:
// each entry keeps its own native buttons (the per-card callback tokens), so
// an exact answer to any card remains possible.
//
// How it works without touching the vendor publication lane:
//
//  1. `enqueueIssueInteractionChatPublications` (vendor, U2-extended) keeps
//     inserting one pending `interaction:<id>:<endpoint>` publication per
//     card, exactly as today — nothing is lost and the durable per-card
//     action tokens are unchanged.
//  2. This module's sweep (`sweepTelegramNotifyCardBundles`) periodically
//     finds conversations that have MORE THAN ONE pending interaction-card
//     publication whose head is older than the window. It then inserts ONE
//     additional summary publication (key `bundle:<endpoint>:<conversation>:<headId>`)
//     that lists every bundled card (title + the per-card native buttons),
//     and marks the individual pending publications as superseded by the
//     bundle (`state: 'cancelled'`, redactedError carries the bundle key).
//     A conversation with a single pending card is left alone: it publishes
//     by itself, exactly the current behavior.
//
// The summary is built through the vendor's own `projectSafeChatPublication`
// boundary and goes out through the same publication path
// (endpoint/conversation) — no new Telegram client.
//
// Bundling only ever reduces provider messages; it never drops a card: the
// per-card callback action rows (chat_actions) are left untouched, so the
// buttons of a bundled card still resolve to that exact interaction.

import { and, asc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import {
  chatConversations,
  chatEndpoints,
  chatPublications,
  type Db,
} from "@paperclipai/db";
import { projectSafeChatPublication } from "../../services/chat-publication-projection.js";
import { PRODUCT_NAME } from "../product.js";
import type {
  SafeExternalChatCardAction,
  SafeChatPublicationPayload,
} from "@paperclipai/shared";

/** The bundling window, in milliseconds. */
export const TELEGRAM_NOTIFY_BUNDLE_WINDOW_MS = 5 * 60 * 1_000;

/** Never bundle more cards than one summary can legibly carry. */
export const MAX_BUNDLED_CARDS = 12;

type BundleDb = Pick<Db, "select" | "update" | "insert">;

interface PendingCardRow {
  id: string;
  companyId: string;
  endpointId: string;
  conversationId: string;
  issueId: string | null;
  idempotencyKey: string;
  payload: SafeChatPublicationPayload;
  createdAt: Date;
}

/**
 * One pass: for every conversation with more than one pending interaction
 * card past the window, publish one summary and supersede the bundled cards.
 * Returns the number of bundles created.
 */
export async function sweepTelegramNotifyCardBundles(
  db: BundleDb,
  input: { now?: () => Date } = {},
): Promise<number> {
  const now = input.now ?? (() => new Date());
  const cutoff = new Date(now().getTime() - TELEGRAM_NOTIFY_BUNDLE_WINDOW_MS);

  const candidates = (await db
    .select({
      id: chatPublications.id,
      companyId: chatPublications.companyId,
      endpointId: chatPublications.endpointId,
      conversationId: chatPublications.conversationId,
      issueId: chatPublications.issueId,
      idempotencyKey: chatPublications.idempotencyKey,
      payload: chatPublications.payload,
      createdAt: chatPublications.createdAt,
    })
    .from(chatPublications)
    .where(
      and(
        eq(chatPublications.state, "pending"),
        sql`${chatPublications.idempotencyKey} like 'interaction:%'`,
        lt(chatPublications.createdAt, cutoff),
        isNull(chatPublications.nextAttemptAt),
      ),
    )
    .orderBy(asc(chatPublications.createdAt), asc(chatPublications.id))
    .limit(500)) as PendingCardRow[];

  if (candidates.length === 0) return 0;

  const byConversation = new Map<string, PendingCardRow[]>();
  for (const row of candidates) {
    const key = `${row.endpointId}:${row.conversationId}`;
    const list = byConversation.get(key) ?? [];
    list.push(row);
    byConversation.set(key, list);
  }

  let bundles = 0;
  for (const [key, rows] of byConversation) {
    if (rows.length < 2) continue;
    const bundled = rows.slice(0, MAX_BUNDLED_CARDS);
    const [endpointId, conversationId] = key.split(":");
    const bundleKey = await insertCardBundle(db, bundled, {
      endpointId,
      conversationId,
      now: now(),
    });
    if (!bundleKey) continue;
    bundles += 1;
    await db
      .update(chatPublications)
      .set({
        state: "cancelled",
        nextAttemptAt: null,
        redactedError: `Superseded by card bundle ${bundleKey}`,
        updatedAt: now(),
      })
      .where(
        and(
          inArray(
            chatPublications.id,
            bundled.map((row) => row.id),
          ),
          eq(chatPublications.state, "pending"),
        ),
      );
  }
  return bundles;
}

/**
 * Build and insert the one summary publication for a set of bundled cards.
 * Returns the bundle idempotency key, or null when nothing was inserted
 * (not a Telegram conversation, or the bundle row already exists).
 */
async function insertCardBundle(
  db: BundleDb,
  bundled: PendingCardRow[],
  target: { endpointId: string; conversationId: string; now: Date },
): Promise<string | null> {
  const provider = await db
    .select({ provider: chatEndpoints.provider })
    .from(chatEndpoints)
    .where(eq(chatEndpoints.id, target.endpointId))
    .then((rows) => rows[0]?.provider ?? null);
  if (provider !== "telegram") return null;
  const conversationRows = (await db
    .select({ companyId: chatConversations.companyId })
    .from(chatConversations)
    .where(eq(chatConversations.id, target.conversationId))) as Array<{
    companyId: string;
  }>;
  const conversation = conversationRows[0] ?? null;
  if (!conversation) return null;

  const lines: string[] = [];
  const actions: SafeExternalChatCardAction[] = [];
  for (const row of bundled) {
    const card = row.payload?.card;
    const title = card?.title ?? "Decision needed";
    lines.push(`• ${title}`);
    for (const action of card?.actions ?? []) {
      if (action.type === "link" && action.url) {
        actions.push({
          type: "link",
          label: `${title}: ${action.label}`,
          url: action.url,
        });
      }
    }
  }

  const bundleKey = `bundle:${target.endpointId}:${target.conversationId}:${bundled[0]!.id}`;
  const payload = projectSafeChatPublication({
    classification: "external",
    source: "issue_interaction",
    text: `${bundled.length} cards need your decision in ${PRODUCT_NAME}:\n${lines.join("\n")}`,
    interaction: {
      id: bundled[0]!.id,
      card: {
        kind: "question",
        title: `${bundled.length} decisions needed`,
        body: lines.join("\n"),
        actions: actions.length > 0 ? actions : undefined,
      },
    },
  });

  const inserted = (await db
    .insert(chatPublications)
    .values({
      companyId: conversation.companyId,
      endpointId: target.endpointId,
      conversationId: target.conversationId,
      issueId: bundled[0]!.issueId as string,
      idempotencyKey: bundleKey,
      payload,
      state: "pending" as const,
      createdAt: target.now,
      updatedAt: target.now,
    })
    .onConflictDoNothing()
    .returning({ id: chatPublications.id })) as { length: number };
  if (inserted.length === 0) return null;
  return bundleKey;
}
