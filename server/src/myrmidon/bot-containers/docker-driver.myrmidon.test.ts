import { describe, expect, it } from "vitest";
import { buildCreateContainerRequestBody, buildSwapScript, type DockerDriverConfig } from "./docker-driver.js";
import { BotContainerTemplateError } from "./template.js";
import type { BotContainerSpec } from "./driver.js";

const CONFIG: Pick<DockerDriverConfig, "volumeRoot" | "network" | "allowlist"> = {
  volumeRoot: "/srv/myrmidon/bots",
  network: "myrmidon-bots",
  allowlist: ["myrmidon-hermes:*"],
};

function spec(overrides: Partial<BotContainerSpec> = {}): BotContainerSpec {
  return {
    botKey: "agent-a",
    image: "myrmidon-hermes:1.1.0",
    memoryMb: 1536,
    cpus: 1,
    pidsLimit: 256,
    network: "myrmidon-bots",
    ...overrides,
  };
}

const PROFILE = { restartHash: "rhash", filesHash: "fhash" };

describe("buildCreateContainerRequestBody", () => {
  it("builds the fixed template body for an allowed image and the configured network", () => {
    const body = buildCreateContainerRequestBody(spec(), PROFILE, CONFIG);
    expect(body).toEqual({
      Image: "myrmidon-hermes:1.1.0",
      Labels: {
        "myrmidon.bot": "agent-a",
        "myrmidon.restart_hash": "rhash",
        "myrmidon.files_hash": "fhash",
        "myrmidon.image": "myrmidon-hermes:1.1.0",
      },
      HostConfig: {
        Memory: 1536 * 1024 * 1024,
        NanoCpus: 1_000_000_000,
        PidsLimit: 256,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges"],
        ReadonlyRootfs: true,
        Tmpfs: { "/tmp": "" },
        Init: true,
        RestartPolicy: { Name: "on-failure" },
        NetworkMode: "myrmidon-bots",
        Binds: [
          "/srv/myrmidon/bots/agent-a/hermes:/data/hermes",
          "/srv/myrmidon/bots/agent-a/workspace:/workspace",
          "/srv/myrmidon/bots/agent-a/scratch:/scratch",
        ],
        Privileged: false,
      },
    });
  });

  it("never sets Privileged, host networking or any bind beyond the fixed three", () => {
    const body = buildCreateContainerRequestBody(spec(), PROFILE, CONFIG);
    expect(body.HostConfig.Privileged).toBe(false);
    expect(body.HostConfig.NetworkMode).not.toBe("host");
    expect(body.HostConfig.Binds).toHaveLength(3);
  });

  it("rejects an image outside the allowlist", () => {
    expect(() => buildCreateContainerRequestBody(spec({ image: "evil/other:latest" }), PROFILE, CONFIG)).toThrow(
      BotContainerTemplateError,
    );
  });

  it("rejects a network other than the driver's configured one — a caller cannot put a bot elsewhere", () => {
    expect(() => buildCreateContainerRequestBody(spec({ network: "host" }), PROFILE, CONFIG)).toThrow(
      BotContainerTemplateError,
    );
    expect(() => buildCreateContainerRequestBody(spec({ network: "some-other-network" }), PROFILE, CONFIG)).toThrow(
      BotContainerTemplateError,
    );
  });

  it("rejects an invalid bot key before it can reach a bind or container name", () => {
    expect(() => buildCreateContainerRequestBody(spec({ botKey: "../etc" }), PROFILE, CONFIG)).toThrow(
      BotContainerTemplateError,
    );
  });

  it("rejects non-positive resource limits", () => {
    expect(() => buildCreateContainerRequestBody(spec({ memoryMb: 0 }), PROFILE, CONFIG)).toThrow(
      BotContainerTemplateError,
    );
    expect(() => buildCreateContainerRequestBody(spec({ cpus: -1 }), PROFILE, CONFIG)).toThrow(
      BotContainerTemplateError,
    );
    expect(() => buildCreateContainerRequestBody(spec({ pidsLimit: 0 }), PROFILE, CONFIG)).toThrow(
      BotContainerTemplateError,
    );
  });

  it("cannot be steered onto a foreign volume: Binds only ever come from volumeRoot + botKey", () => {
    // BotContainerSpec has no field for a path at all — this asserts the produced
    // Binds never contain anything but the three fixed, driver-computed mounts.
    const body = buildCreateContainerRequestBody(spec(), PROFILE, CONFIG);
    for (const bind of body.HostConfig.Binds) {
      expect(bind.startsWith(`${CONFIG.volumeRoot}/agent-a/`)).toBe(true);
    }
  });
});

describe("buildSwapScript", () => {
  it("builds a script that moves staged files for each given root and skips missing staging dirs", () => {
    const script = buildSwapScript(["data/hermes", "workspace"]);
    expect(script).toContain('staging="/data/hermes/.myrmidon-next"');
    expect(script).toContain('staging="/workspace/.myrmidon-next"');
    expect(script).toContain("set -e");
    expect(script).toContain("rm -rf \"$staging\"");
  });

  it("is empty-but-valid (just \"set -e\") for no roots", () => {
    expect(buildSwapScript([])).toBe("set -e");
  });
});
