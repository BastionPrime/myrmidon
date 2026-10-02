// myrmidon(EXT-CASE-OCR): the structural excerpt.
//
// The fixture is a neutral tender pack ("Example tender", example.com addresses,
// no real organisation): the suite tests the reading rules, not the wording of a
// particular document.

import { describe, expect, it } from "vitest";
import { extractTenderStructure } from "./structure.js";

const TENDER = `Пример закупочной документации
Заказчик: Example Company
Контакт: tender@example.com

1. Требования к участникам закупки
Участник должен быть зарегистрирован не позднее чем за год до даты подачи заявки.
Участник должен иметь лицензию на выполнение работ.
- Не допускается привлечение субподрядчиков без письменного согласия заказчика.
Заявка должна содержать сведения о квалификации исполнителя.

2. Сроки
Срок подачи заявок — до 31.12.2026.
Окончание приёма заявок: 15/01/2027.
Вскрытие конвертов состоится 20 января 2027 года.

3. Перечень позиций
Стол письменный 12 шт
Кресло офисное 8 шт
Услуги сопровождения 1 комплект

Приложение
Порядок оплаты описан отдельно.
`;

describe("extractTenderStructure", () => {
  it("reads requirements from the requirements section and from obligation lines", () => {
    const { requirements } = extractTenderStructure(TENDER);
    const texts = requirements.map((item) => item.text);
    expect(texts).toContain("Участник должен быть зарегистрирован не позднее чем за год до даты подачи заявки.");
    expect(texts).toContain("Участник должен иметь лицензию на выполнение работ.");
    expect(texts).toContain("Не допускается привлечение субподрядчиков без письменного согласия заказчика.");
    expect(texts).toContain("Заявка должна содержать сведения о квалификации исполнителя.");
  });

  it("normalizes the three date forms a tender uses", () => {
    const { deadlines } = extractTenderStructure(TENDER);
    const dates = deadlines.map((item) => item.date);
    expect(dates).toContain("2026-12-31");
    expect(dates).toContain("2027-01-15");
    expect(dates).toContain("2027-01-20");
  });

  it("keeps the deadline line as the citation for its date", () => {
    const { deadlines } = extractTenderStructure(TENDER);
    const entry = deadlines.find((item) => item.date === "2026-12-31");
    expect(entry?.text).toBe("Срок подачи заявок — до 31.12.2026.");
  });

  it("does not repeat a deadline line as a requirement", () => {
    const { requirements } = extractTenderStructure(TENDER);
    expect(requirements.some((item) => item.text.includes("31.12.2026"))).toBe(false);
  });

  it("reads positions with quantity and unit", () => {
    const { positions } = extractTenderStructure(TENDER);
    expect(positions).toEqual([
      { name: "Стол письменный", quantity: "12", unit: "шт" },
      { name: "Кресло офисное", quantity: "8", unit: "шт" },
      { name: "Услуги сопровождения", quantity: "1", unit: "комплект" },
    ]);
  });

  it("reads a table-shaped row", () => {
    const { positions } = extractTenderStructure("Бумага офисная | 500 | упак");
    expect(positions).toEqual([{ name: "Бумага офисная", quantity: "500", unit: "упак" }]);
  });

  it("ends a section at the next heading", () => {
    const { requirements, positions } = extractTenderStructure(
      "Требования\nРаботы должны выполняться по графику заказчика.\nПозиции\nКабель 5 м\n",
    );
    expect(requirements.map((item) => item.text)).toEqual(["Работы должны выполняться по графику заказчика."]);
    expect(positions).toHaveLength(1);
  });

  it("does not invent a position out of a deadline line with a number and a word", () => {
    const { positions } = extractTenderStructure("Срок поставки 5 дней");
    expect(positions).toEqual([]);
  });

  it("keeps the first occurrence of a repeated line and honours the caps", () => {
    const repeated = extractTenderStructure(
      "Требования\nУчастник должен подтвердить опыт.\nУчастник должен подтвердить опыт.\n",
    );
    expect(repeated.requirements).toHaveLength(1);

    const capped = extractTenderStructure(
      Array.from({ length: 10 }, (_, index) => `Участник должен выполнить условие ${index}.`).join("\n"),
      { maxRequirements: 3, maxDeadlines: 3, maxPositions: 3 },
    );
    expect(capped.requirements).toHaveLength(3);
  });

  it("trims a very long line instead of storing the whole page", () => {
    const long = `Участник должен ${"подтвердить ".repeat(60)}опыт.`;
    const { requirements } = extractTenderStructure(long);
    expect(requirements).toHaveLength(1);
    expect(requirements[0]!.text.length).toBeLessThanOrEqual(400);
    expect(requirements[0]!.text.endsWith("…")).toBe(true);
  });

  it("returns empty lists for a document with no tender markers", () => {
    const empty = extractTenderStructure("Счёт-фактура\nВсего к оплате: 1000 рублей.\n");
    expect(empty.requirements).toEqual([]);
    expect(empty.deadlines).toEqual([]);
    expect(empty.positions).toEqual([]);
  });
});