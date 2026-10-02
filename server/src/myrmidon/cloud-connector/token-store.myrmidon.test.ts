// myrmidon(CLOUD-CONNECTOR): token-store tests.
//
// The connector keeps only the secret id; the bundle itself lives in the
// instance secret store. The database-backed store is vendor integration
// (secretService.create/resolveSecretValue/rotate); the in-memory store has
// the same contract and is what the rest of the tests run against, so this
// file pins that contract: write, read with the version, rotate forward.

import { describe, expect, it } from "vitest";
import { memoryCloudTokenStore } from "./token-store.js";

describe("memory cloud token store", () => {
  it("writes a bundle and reads it back with its version", async () => {
    const store = memoryCloudTokenStore();
    const { secretId, version } = await store.write({
      companyId: "company-a",
      name: "myrmidon-cloud-onedrive",
      key: "myrmidon_cloud_onedrive",
      value: "bundle-1",
    });
    expect(version).toBe(1);
    expect(await store.read("company-a", secretId)).toEqual({ value: "bundle-1", version: 1 });
  });

  it("reads a missing secret as absent", async () => {
    expect(await memoryCloudTokenStore().read("company-a", "nothing")).toBeNull();
  });

  it("rotates forward and answers the new version", async () => {
    const store = memoryCloudTokenStore();
    const { secretId } = await store.write({
      companyId: "company-a",
      name: "n",
      key: "k",
      value: "bundle-1",
    });
    expect(await store.rotate({ secretId, value: "bundle-2", expectedLatestVersion: 1 })).toBe(2);
    expect(await store.read("company-a", secretId)).toEqual({ value: "bundle-2", version: 2 });
  });

  it("gives one secret id per write, so a lost reference is never guessed", async () => {
    const store = memoryCloudTokenStore();
    const first = await store.write({ companyId: "company-a", name: "n", key: "k", value: "a" });
    const second = await store.write({ companyId: "company-a", name: "n", key: "k", value: "b" });
    expect(first.secretId).not.toBe(second.secretId);
  });
});