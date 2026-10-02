// myrmidon(EXTCASE-M): the tender fields of a recognized document.
//
// The excerpt is what a person reads first on the board task, so the tests are
// about the two properties that make it worth having: the fields are found in
// the forms a Russian tender actually uses, and the function is a pure reading
// of the text — no model, so the same input gives the same answer.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_TENDER_DOSSIER_LIMITS,
  buildTenderDossier,
  cleanDossierLine,
  dossierIsActionable,
  extractDateIso,
  extractTenderNumber,
  extractTenderPart,
  looksLikeTender,
  mergeTenderParts,
} from "./dossier.js";

const SAMPLE = [
  "Извещение о проведении электронного аукциона",
  "Номер закупки: 44-ФЗ/12345",
  "Заказчик: пример организации",
  "Дата окончания подачи заявок: 15.10.2026",
  "Подведение итогов — 20 октября 2026",
  "НМЦК: 1 500 000,00 руб.",
  "Обеспечение заявки: 15 000 руб.",
  "Участник должен предоставить обеспечение исполнения контракта.",
  "Не допускается отклонение от технического задания.",
  "Позиция 1: Шкаф металлический 12 шт",
  "Услуги по доставке 3 ед",
].join("\n");

describe("extractDateIso", () => {
  it.each([
    ["15.10.2026", "2026-10-15"],
    ["15/10/2026", "2026-10-15"],
    ["2026-10-15", "2026-10-15"],
    ["20 октября 2026", "2026-10-20"],
    ["1 мая 2026", "2026-05-01"],
  ])("normalizes %s to %s", (line, expected) => {
    expect(extractDateIso(line)).toBe(expected);
  });

  it("returns null when the line carries no full date", () => {
    expect(extractDateIso("срок подачи — десять дней")).toBeNull();
  });
});

describe("extractTenderNumber", () => {
  it("reads a labelled procurement number with a slash", () => {
    expect(extractTenderNumber("Номер закупки: 44-ФЗ/12345")).toBe("44-ФЗ/12345");
  });

  it("reads a number written after «извещение»", () => {
    expect(extractTenderNumber("Извещение № 0173100004526000123 о проведении аукциона")).toBe("0173100004526000123");
  });

  it("refuses a label followed by prose rather than a number", () => {
    expect(extractTenderNumber("Закупка товаров для нужд заказчика")).toBeNull();
  });
});

describe("extractTenderPart", () => {
  it("reads the number, the deadlines, the sums and the requirements", () => {
    const part = extractTenderPart({ text: SAMPLE, messageId: "m-1", attachmentName: "documentation.pdf" });
    expect(part.number).toBe("44-ФЗ/12345");
    expect(part.deadlines.map((deadline) => deadline.date)).toEqual(["2026-10-15", "2026-10-20"]);
    expect(part.sums.map((sum) => sum.amount)).toEqual([1500000, 15000]);
    expect(part.sums.every((sum) => sum.currency === "RUB")).toBe(true);
    expect(part.requirements).toEqual([
      "Участник должен предоставить обеспечение исполнения контракта.",
      "Не допускается отклонение от технического задания.",
    ]);
  });

  it("is deterministic: the same text gives the same part", () => {
    const input = { text: SAMPLE, messageId: "m-1", attachmentName: "d.pdf" };
    expect(extractTenderPart(input)).toEqual(extractTenderPart(input));
  });

  it("respects the caps", () => {
    const part = extractTenderPart(
      { text: SAMPLE, messageId: "m-1", attachmentName: "d.pdf" },
      { ...DEFAULT_TENDER_DOSSIER_LIMITS, maxDeadlines: 1, maxSums: 1, maxRequirements: 1 },
    );
    expect(part.deadlines).toHaveLength(1);
    expect(part.sums).toHaveLength(1);
    expect(part.requirements).toHaveLength(1);
  });

  it("does not treat an amount below a thousand as a sum — that is a quantity", () => {
    const part = extractTenderPart({
      text: "Цена договора: 500 руб.\nПозиция 12 шт",
      messageId: "m-1",
      attachmentName: "d.pdf",
    });
    expect(part.sums).toHaveLength(0);
  });

  it("records a deadline that has an obligation word but no full date", () => {
    const part = extractTenderPart({
      text: "Срок подачи заявок — десять рабочих дней",
      messageId: "m-1",
      attachmentName: "d.pdf",
    });
    expect(part.deadlines).toEqual([{ text: "Срок подачи заявок — десять рабочих дней", date: null }]);
  });

  it("keeps a repeated line once", () => {
    const part = extractTenderPart({
      text: "Срок подачи заявок: 15.10.2026\nСрок подачи заявок: 15.10.2026",
      messageId: "m-1",
      attachmentName: "d.pdf",
    });
    expect(part.deadlines).toHaveLength(1);
  });
});

describe("mergeTenderParts and buildTenderDossier", () => {
  it("keeps the first number seen and concatenates the fields", () => {
    const merged = mergeTenderParts([
      { number: null, deadlines: [{ text: "a", date: null }], sums: [], requirements: [] },
      { number: "123", deadlines: [], sums: [{ text: "b", amount: 1000, currency: "RUB" }], requirements: [] },
    ]);
    expect(merged.number).toBe("123");
    expect(merged.deadlines).toHaveLength(1);
    expect(merged.sums).toHaveLength(1);
  });

  it("names the message and the attachments the dossier was read from", () => {
    const dossier = buildTenderDossier({
      parts: [extractTenderPart({ text: SAMPLE, messageId: "m-1", attachmentName: "d.pdf" })],
      messageId: "m-1",
      attachmentNames: ["d.pdf"],
    });
    expect(dossier.messageId).toBe("m-1");
    expect(dossier.attachments).toEqual(["d.pdf"]);
  });
});

describe("dossierIsActionable", () => {
  const base = { deadlines: [], sums: [], requirements: [], messageId: "m", attachments: [] };

  it("is actionable with a number, a deadline or a sum", () => {
    expect(dossierIsActionable({ ...base, number: "1" })).toBe(true);
    expect(dossierIsActionable({ ...base, number: null, deadlines: [{ text: "t", date: null }] })).toBe(true);
    expect(dossierIsActionable({ ...base, number: null, sums: [{ text: "t", amount: 1, currency: null }] })).toBe(true);
  });

  it("is not actionable for prose with none of them", () => {
    expect(dossierIsActionable({ ...base, number: null, requirements: ["должен"] })).toBe(false);
  });
});

describe("looksLikeTender", () => {
  it.each(["Извещение о закупке", "Тендерная документация", "Аукцион на поставку", "Техническое задание"])(
    "recognizes %s",
    (text) => {
      expect(looksLikeTender(text)).toBe(true);
    },
  );

  it("does not treat ordinary correspondence as a tender", () => {
    expect(looksLikeTender("Добрый день, направляю договор аренды")).toBe(false);
  });
});

describe("cleanDossierLine", () => {
  it("collapses whitespace and caps the line", () => {
    expect(cleanDossierLine("  a   b  ")).toBe("a b");
    expect(cleanDossierLine("x".repeat(500)).endsWith("…")).toBe(true);
    expect(cleanDossierLine("x".repeat(500)).length).toBe(400);
  });
});