// myrmidon(1.6-TG-PROACTIVITY-E): the proactivity + bundling sweep.
//
// One periodic pass, wired into the chat reconciliation coordinator's
// publication lane (server/src/app.ts, marker `myrmidon(1.6-TG-PROACTIVITY-E)`):
//
//   1. U2 card bundling — `sweepTelegramNotifyCardBundles` (card-bundler.ts):
//      several pending interaction cards in one conversation past the window
//      become one summary publication; a single card is left alone.
//   2. rarely digests — the proactive texts the gate bundled (queued in the
//      instance-settings document) become one summary publication per
//      conversation. The queue is drained into the durable outbox, so the
//      vendor's own delivery lane carries them through the existing
//      endpoint/conversation path; nothing here talks to a provider.
//
// Off by default: without any settings the gate is
// only_on_owner_request, nothing is ever queued, the card bundler only ever
// coalesces pending cards (which cannot appear for a default installation
// that never enabled owner delivery), and the digest step has an empty queue.

import { chatPublications, type Db } from "@paperclipai/db";
import { projectSafeChatPublication } from "../../services/chat-publication-projection.js";
import { PRODUCT_NAME } from "../product.js";
import { sweepTelegramNotifyCardBundles } from "./card-bundler.js";
import { takeBundledProactivityQueues } from "./proactivity-policy.js";

/**
 * Drain every conversation's bundled proactive queue into one pending
 * summary publication each. Returns the number of digests enqueued.
 */
export async function sweepTelegramNotifyProactivityDigests(
  db: Db,
): Promise<number> {
  const queues = await takeBundledProactivityQueues(db);
  let enqueued = 0;
  for (const queue of queues) {
    if (queue.texts.length === 0) continue;
    const digestKey = `proactivity-digest:${queue.endpointId}:${queue.conversationId}:${queue.lastAt}`;
    const payload = projectSafeChatPublication({
      classification: "external",
      source: "safe_milestone",
      text: `${PRODUCT_NAME} summary (${queue.texts.length} items):\n${queue.texts
        .map((text) => `• ${text.split("\n")[0]!.slice(0, 200)}`)
        .join("\n")}`,
    });
    const inserted = (await db
      .insert(chatPublications)
      .values({
        companyId: queue.companyId,
        endpointId: queue.endpointId,
        conversationId: queue.conversationId,
        issueId: queue.issueId as string,
        idempotencyKey: digestKey,
        payload,
        state: "pending" as const,
      })
      .onConflictDoNothing()
      .returning({ id: chatPublications.id })) as { length: number };
    enqueued += inserted.length;
  }
  return enqueued;
}

/** One full pass: card bundles first, then rarely digests. */
export async function sweepTelegramNotifyProactivity(
  db: Db,
): Promise<{ cardBundles: number; digests: number }> {
  const cardBundles = await sweepTelegramNotifyCardBundles(db);
  const digests = await sweepTelegramNotifyProactivityDigests(db);
  return { cardBundles, digests };
}