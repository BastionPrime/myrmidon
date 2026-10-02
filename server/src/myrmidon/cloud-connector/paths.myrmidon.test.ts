// myrmidon(CLOUD-CONNECTOR): path confinement tests.
//
// The connector must accept exactly the paths the temporary cloud-files
// service accepted and refuse the rest, so an agent can never climb out of a
// granted root with `..`, a separator trick or a bad segment.

import { describe, expect, it } from "vitest";
import { CloudConnectorError } from "./types.js";
import { isWithinCloudFolder, joinCloudPath, normalizeCloudName, splitCloudPath } from "./paths.js";

describe("splitCloudPath", () => {
  it("normalises separators and drops empty and dot segments", () => {
    expect(splitCloudPath("a//b/./c")).toEqual(["a", "b", "c"]);
    expect(splitCloudPath("a\\b")).toEqual(["a", "b"]);
    expect(splitCloudPath("")).toEqual([]);
    expect(splitCloudPath(null)).toEqual([]);
  });

  it("normalises the composed and decomposed spellings to one form", () => {
    expect(splitCloudPath("Cafe\u0301/report")).toEqual(["Caf\u00e9", "report"]);
  });

  it("refuses a parent traversal", () => {
    expect(() => splitCloudPath("a/../b")).toThrow(CloudConnectorError);
  });

  it("refuses characters the provider does not allow", () => {
    expect(() => splitCloudPath("a:b")).toThrow(CloudConnectorError);
    expect(() => splitCloudPath("a<b")).toThrow(CloudConnectorError);
  });

  it("refuses a path that is too deep", () => {
    const deep = Array.from({ length: 33 }, (_, index) => `s${index}`).join("/");
    expect(() => splitCloudPath(deep)).toThrow(CloudConnectorError);
  });
});

describe("normalizeCloudName", () => {
  it("compares the composed and decomposed spellings as equal", () => {
    expect(normalizeCloudName("Caf\u00e9")).toBe(normalizeCloudName("Cafe\u0301"));
  });

  it("ignores case", () => {
    expect(normalizeCloudName("Report.TXT")).toBe("report.txt");
  });
});

describe("isWithinCloudFolder", () => {
  it("accepts the folder itself and anything below it", () => {
    expect(isWithinCloudFolder(["work"], ["work"])).toBe(true);
    expect(isWithinCloudFolder(["work"], ["work", "a.txt"])).toBe(true);
  });

  it("rejects a sibling and a parent", () => {
    expect(isWithinCloudFolder(["work"], ["other", "a.txt"])).toBe(false);
    expect(isWithinCloudFolder(["work", "sub"], ["work"])).toBe(false);
  });
});

describe("joinCloudPath", () => {
  it("joins segments and keeps the root empty", () => {
    expect(joinCloudPath(["a", "b"])).toBe("a/b");
    expect(joinCloudPath([])).toBe("");
  });
});