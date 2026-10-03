// myrmidon(1.6-CTO-CHAT-A): guard test for the Commander chat screen — the
// portal entry of the free-text planning flow. Part A contract:
//   - the ui2 route table carries the commander-chat route and the nav
//     (rail + phone tab) plus the palette all point at it;
//   - the screen sends the owner's text to the Part B planner
//     (POST /api/myrmidon/companies/:id/cto-chat/plan) and renders the
//     returned epic draft, without `expect` and without creating issues
//     client-side;
//   - the suggest_tasks card on the standing Agent Chat issue is rendered
//     via the existing IssueThreadInteractionCard, and accept/reject call the
//     existing interaction endpoints.
// The planning endpoint itself is Part B's (see the seam note in the epic
// thread); here we pin the client contract so a server-side change cannot
// silently drift.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_SRC = join(HERE, "..", "..");
const UI2_SRC = join(HERE, "..");
const SCREEN = readFileSync(join(HERE, "CommanderChatScreen.tsx"), "utf8");
const CLIENT = readFileSync(join(UI_SRC, "api", "ctoChat.ts"), "utf8");
const ROUTES = readFileSync(join(UI2_SRC, "routes.tsx"), "utf8");
const NAV = readFileSync(join(UI_SRC, "ui2", "navModel.ts"), "utf8");
const PALETTE = readFileSync(join(UI_SRC, "ui2", "shell", "Ui2CommanderPalette.tsx"), "utf8");

describe("cto-chat client contract (Part A ⇄ Part B seam)", () => {
  it("posts to the Part B planner endpoint with the agreed shape", () => {
    expect(CLIENT).toMatch(/\/myrmidon\/companies\/\$\{companyId\}\/cto-chat\/plan/);
    expect(CLIENT).toMatch(/source:\s*\{\s*kind:\s*"portal"\s*\|\s*"telegram"\s*\}/);
    // acceptanceCriteria stays a separate array (card renders line by line).
    expect(CLIENT).toMatch(/acceptanceCriteria:\s*string\[\]/);
    // parentClientKey links children to the epic's clientKey.
    expect(CLIENT).toMatch(/parentClientKey:\s*string\s*\|\s*null/);
  });

  it("never sends `expect` — the planner always answers with a plan", () => {
    expect(CLIENT).not.toMatch(/expect/);
    expect(SCREEN).not.toMatch(/["']expect["']/);
  });

  it("the screen creates no issues client-side — only the planner + card flow", () => {
    expect(SCREEN).not.toMatch(/createIssue|agentChatsApi\.ensure/);
  });
});

describe("commander chat screen wiring", () => {
  it("has a ui2 route entry pointing at the screen", () => {
    expect(ROUTES).toMatch(/key:\s*"commander-chat"/);
    // myrmidon(UI-2.0-WAVE-A): the screen moved to its own /commander root
    // (ia-v2 §2.2.2); /commander-chat redirects there.
    expect(ROUTES).toMatch(/path:\s*"commander"/);
    expect(ROUTES).toMatch(/CommanderChatScreen/);
  });

  it("nav rail and phone tab point to the commander chat, not the legacy conference room", () => {
    // myrmidon(UI-2.0-WAVE-A): same, now on the /commander root.
    expect(NAV).toMatch(/ui2\.nav\.commander",\s*to:\s*"\/commander"/);
    expect(NAV).not.toMatch(/ui2\.nav\.commander",\s*to:\s*"\/board-chat"/);
  });

  it("the palette carries the typed draft over to the screen", () => {
    expect(PALETTE).toMatch(/\/commander\?draft=/);
    expect(PALETTE).not.toMatch(/navigate\("\/board-chat"\)/);
  });

  it("renders the pending suggest_tasks card via the existing card component", () => {
    expect(SCREEN).toMatch(/IssueThreadInteractionCard/);
    expect(SCREEN).toMatch(/kind === "suggest_tasks"/);
    expect(SCREEN).toMatch(/onAcceptInteraction/);
    expect(SCREEN).toMatch(/onRejectInteraction/);
    // Accept/reject go through the existing endpoints, not new ones.
    expect(SCREEN).toMatch(/issuesApi\.acceptInteraction/);
    expect(SCREEN).toMatch(/issuesApi\.rejectInteraction/);
  });

  it("marks itself with the 1.6-CTO-CHAT marker", () => {
    expect(SCREEN).toMatch(/myrmidon\(1\.6-CTO-CHAT-A\)/);
  });

  it("i18n carries the commanderChat keys in the ui2 catalogs (en and ru)", async () => {
    const { en } = await import("../i18n/catalogs/en");
    const { ru } = await import("../i18n/catalogs/ru");
    for (const catalog of [en, ru]) {
      expect(catalog.commanderChat.title).toBeTruthy();
      expect(catalog.commanderChat.send).toBeTruthy();
      expect(catalog.commanderChat.resolving).toBeTruthy();
    }
    // The RU copy is Russian, not copied English.
    expect(ru.commanderChat.title).toBe("Чат с Полководцем");
  });
});
