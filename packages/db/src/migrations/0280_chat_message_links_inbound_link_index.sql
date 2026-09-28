-- myrmidon(D1): chat_message_links had no index covering (company_id,
-- conversation_id, direction, comment_id). The chat run-milestone
-- reconciliation sweep (enqueueChatRunMilestones) checks, once per candidate
-- run on every poll, whether an inbound message already links to a given
-- comment; without this index that check was a full table scan repeated on
-- every call, dominating the sweep's cost as chat_message_links grows.
CREATE INDEX IF NOT EXISTS "chat_message_links_inbound_link_idx" ON "chat_message_links" USING btree ("company_id","conversation_id","direction","comment_id");
