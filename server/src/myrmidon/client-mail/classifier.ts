// server/src/myrmidon/client-mail/classifier.ts
//
// myrmidon(EXTCASE-M): the second classifier — a model, and only where a rule
// left a decision open.
//
// Rules decide first (rules.ts). A message no rule claimed is sent here: one
// short request through the LLM gateway of the contour the client company was
// given, with the folders and categories the client configured, and a strict
// answer shape. The answer is validated against that vocabulary in
// `decisionFromModelAnswer` — the model picks *among* the client's folders, it
// never invents one — and an answer outside it is dropped in favour of the
// configured fallback.
//
// Two properties matter more than the prompt:
//
// - the body sent to the model is capped (`maxBodyChars`), because a tender pack
//   pasted into a mail body would otherwise cost a fortune and change nothing;
// - a failed call is a *reported* fact, not an exception that loses the message:
//   the pipeline falls back to the fallback folder and journals the failure. Mail
//   keeps flowing when the gateway is down, which is the whole point of deciding
//   by rules first.
//
// The API key is read from the company's secrets for the lifetime of one call and
// never stored on the client object, so one client company's key can never be
// used for another company's mail.

import { decisionFromModelAnswer, type ClientMailCompanySettings, type ClientMailDecision, type ClientMailItem } from "@paperclipai/shared";

/** The gateway's OpenAI-compatible endpoint, or null when no address is configured. */
export function classifierCompletionUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return /\/v1$/.test(trimmed) ? `${trimmed}/chat/completions` : `${trimmed}/v1/chat/completions`;
}

export interface MailClassifierRequest {
  /** Model as configured for this client company (`general.clientMail…classifierModel`). */
  model: string;
  /** The folders the answer may name. */
  folders: string[];
  /** The categories the answer may name. */
  categories: string[];
  /** Body text, already capped by the caller. */
  bodyText: string;
  subject: string;
  fromAddress: string | null;
  attachmentNames: string[];
}

/** The prompt. Deliberately instruction-first and closed: the answer is a decision, not prose. */
export function buildClassifierPrompt(request: MailClassifierRequest): string {
  return [
    "You sort incoming mail for a tender department.",
    "Choose where one message belongs, using only the options listed below.",
    "",
    `Folders: ${request.folders.length > 0 ? request.folders.join(", ") : "(none)"}`,
    `Categories: ${request.categories.length > 0 ? request.categories.join(", ") : "(none)"}`,
    "",
    'Answer with one JSON object and nothing else, one of:',
    '{"kind":"folder","folderPath":"<one of the folders>","reason":"<short reason>"}',
    '{"kind":"category","categories":["<one or more of the categories>"],"reason":"<short reason>"}',
    '{"kind":"keep","reason":"<short reason>"}',
    "",
    'Use "keep" when the message matches nothing in the lists. Never invent a folder or a category.',
    "",
    "Message:",
    `Subject: ${request.subject}`,
    `From: ${request.fromAddress ?? "(unknown)"}`,
    `Attachments: ${request.attachmentNames.length > 0 ? request.attachmentNames.join(", ") : "(none)"}`,
    "Body:",
    request.bodyText,
  ].join("\n");
}

/** The JSON object out of a model answer: a bare object, or one inside a fenced block. */
export function readClassifierAnswer(content: string): unknown {
  const trimmed = content.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const candidate = (fenced?.[1] ?? trimmed).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    // A model sometimes wraps the object in a sentence; take the outermost braces.
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

export interface MailClassifierDeps {
  fetch: typeof fetch;
  /** Gateway address; null means the model step is off and the caller falls back. */
  baseUrl: string | null;
  /** Read from the company's secrets for this call; never stored. */
  readApiKey(): Promise<string | null>;
  timeoutMs: number;
}

export interface MailClassifier {
  readonly model: string;
  classify(item: ClientMailItem, settings: ClientMailCompanySettings): Promise<ClientMailDecision | null>;
}

export class MailClassifierError extends Error {}

export function createMailClassifier(model: string, deps: MailClassifierDeps): MailClassifier {
  return {
    model,
    async classify(item, settings) {
      if (!deps.baseUrl) {
        throw new MailClassifierError("the mail classifier has no gateway address configured");
      }
      const apiKey = await deps.readApiKey();
      if (!apiKey) {
        throw new MailClassifierError("the mail classifier API key is not available to this company");
      }
      const request: MailClassifierRequest = {
        model,
        folders: settings.folders,
        categories: settings.categories,
        bodyText: (item.bodyText ?? "").slice(0, settings.maxBodyChars),
        subject: item.subject ?? "",
        fromAddress: item.from?.address ?? null,
        attachmentNames: (item.attachments ?? []).map((attachment) => attachment.name),
      };
      let response: Response;
      try {
        response = await deps.fetch(classifierCompletionUrl(deps.baseUrl), {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({
            model,
            temperature: 0,
            messages: [{ role: "user", content: buildClassifierPrompt(request) }],
          }),
          signal: AbortSignal.timeout(deps.timeoutMs),
        });
      } catch (error) {
        throw new MailClassifierError(
          `the mail classifier is unreachable: ${error instanceof Error ? error.message : "request failed"}`,
        );
      }
      if (!response.ok) {
        // The status only: a failing gateway echoes the request in its body, and
        // the request carries a client's mail.
        throw new MailClassifierError(`the mail classifier answered ${response.status}`);
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new MailClassifierError("the mail classifier answered with a body that is not JSON");
      }
      const content = (payload as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message
        ?.content;
      if (typeof content !== "string" || !content.trim()) {
        throw new MailClassifierError("the mail classifier returned an empty answer");
      }
      const answer = readClassifierAnswer(content);
      // A null here is a legitimate outcome: the answer named a folder or a
      // category the client did not configure, and the pipeline falls back.
      return decisionFromModelAnswer(answer, settings);
    },
  };
}