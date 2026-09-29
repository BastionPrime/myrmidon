import { describe, expect, it } from "vitest";
import type { AskUserQuestionsInteraction } from "@paperclipai/shared";
import { publishPhotonPrompt } from "../../services/photon/interactions.js";
import { photonFixture } from "./fixture.js";

// B1b: the task link line of a Photon prompt carries the product name.
describe("Photon prompt task link (B1b)", () => {
  it("names the product on the task link line", async () => {
    const f = photonFixture();
    const interaction = {
      id: "interaction",
      kind: "ask_user_questions",
      payload: {
        questions: [
          {
            id: "q1",
            prompt: "Pick one",
            options: [
              { id: "a", label: "First" },
              { id: "b", label: "Second" },
            ],
            selectionMode: "single",
            allowOther: false,
            required: true,
          },
        ],
      },
    } as AskUserQuestionsInteraction;
    await publishPhotonPrompt({
      adapter: f.adapter,
      threadId: f.threadId,
      binding: {
        version: 1,
        reference: "referenceA",
        interactionId: "interaction",
        publicationId: "publication1",
        sessionGeneration: 1,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      interaction,
      questionIndex: 0,
      taskUrl: "https://tasks.example/issues/7",
      assertCurrent: async () => {},
    });
    const sent = f.client.messages.sendText.mock.calls
      .map((call) => String(call[1]))
      .join("\n");
    expect(sent).toContain("Open this Myrmidon task: https://tasks.example/issues/7");
    expect(sent).not.toContain("Paperclip");
  });
});
