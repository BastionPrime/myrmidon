import { describe, expect, it } from "vitest";
import { buildRuntimeApiCandidateUrls } from "../runtime-api.js";

const interfaces = {
  eth0: [
    {
      address: "198.51.100.20",
      family: "IPv4" as const,
      internal: false,
      netmask: "255.255.255.0",
      cidr: "198.51.100.20/24",
      mac: "00:00:00:00:00:00",
    },
  ],
};

describe("runtime API candidates (myrmidon P6)", () => {
  it("derives candidates with the listener protocol behind an HTTPS public origin", () => {
    const candidates = buildRuntimeApiCandidateUrls({
      preferredApiUrl: "https://board.example.com:8443",
      authPublicBaseUrl: "https://board.example.com:8443",
      allowedHostnames: ["board.example.com"],
      bindHost: "0.0.0.0",
      port: 3100,
      networkInterfacesMap: interfaces,
    });
    expect(candidates).toEqual([
      "https://board.example.com:8443",
      "http://127.0.0.1:3100",
      "http://board.example.com:3100",
      "http://198.51.100.20:3100",
    ]);
    for (const derived of candidates.slice(1)) expect(derived.startsWith("http://")).toBe(true);
  });

  it("uses https for derived candidates only when the listener itself serves TLS", () => {
    expect(
      buildRuntimeApiCandidateUrls({
        authPublicBaseUrl: "https://board.example.com",
        allowedHostnames: ["board.example.com"],
        bindHost: "0.0.0.0",
        port: 3443,
        networkInterfacesMap: {},
        listenProtocol: "https:",
      }),
    ).toEqual(["https://board.example.com", "https://127.0.0.1:3443", "https://board.example.com:3443"]);
  });

  it("always lists the loopback listener right after the public origins", () => {
    const candidates = buildRuntimeApiCandidateUrls({
      preferredApiUrl: "https://agent-entry.example.com",
      authPublicBaseUrl: "https://board.example.com",
      allowedHostnames: [],
      bindHost: "0.0.0.0",
      port: 3100,
      networkInterfacesMap: interfaces,
    });
    expect(candidates.indexOf("http://127.0.0.1:3100")).toBe(2);
    expect(candidates.at(-1)).toBe("http://198.51.100.20:3100");
  });

  it("lists the loopback listener even with a non-loopback bind host and no public origin", () => {
    expect(
      buildRuntimeApiCandidateUrls({
        authPublicBaseUrl: null,
        allowedHostnames: [],
        bindHost: "198.51.100.20",
        port: 3100,
        networkInterfacesMap: {},
      }),
    ).toEqual(["http://127.0.0.1:3100", "http://198.51.100.20:3100"]);
  });

  it("does not duplicate the loopback candidate", () => {
    const candidates = buildRuntimeApiCandidateUrls({
      preferredApiUrl: "http://127.0.0.1:3100",
      authPublicBaseUrl: null,
      allowedHostnames: ["127.0.0.1"],
      bindHost: "127.0.0.1",
      port: 3100,
      networkInterfacesMap: {},
    });
    expect(candidates).toEqual(["http://127.0.0.1:3100"]);
  });
});
