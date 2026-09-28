import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  APPLIED_MARKER_CONTAINER_PATH,
  BOT_CONTAINER_UID,
  BOT_STOP_TIMEOUT_SEC,
  botStateFromInspect,
  buildApplyScript,
  buildCreateContainerRequestBody,
  buildHelperContainerRequestBody,
  buildPrepareVolumesScript,
  buildProfileArchives,
  computeProfileRemovals,
  containerTemplateDrifted,
  demuxDockerLogs,
  dockerBotContainerDriver,
  parseAppliedMarker,
  type DockerDriverConfig,
} from "./docker-driver.js";
import type { BotContainerDriver, BotContainerSpec } from "./driver.js";
import { BOT_LABEL_KEYS, BotContainerTemplateError } from "./template.js";
import type { CompiledProfile, CompiledProfileFile } from "./types.js";
import { buildUstarArchive, parseUstarArchive, type UstarReadEntry } from "./ustar.js";

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

function plainFile(p: string, content: string): CompiledProfileFile {
  return { path: p, content, mode: 0o644, secret: false };
}

function testProfile(
  opts: { skills?: string[]; extra?: CompiledProfileFile[]; restartHash?: string; filesHash?: string; botKey?: string } = {},
): CompiledProfile {
  const skills = opts.skills ?? ["skill-a"];
  return {
    botKey: opts.botKey ?? "agent-a",
    files: [
      plainFile("hermes/config.yaml", "model:\n  default: example-model\n"),
      { path: "hermes/.env", content: "EXAMPLE_SETTING=1\n", mode: 0o600, secret: true },
      plainFile("hermes/hindsight/config.json", "{}\n"),
      ...skills.map((name) => plainFile(`hermes/skills-board/${name}/SKILL.md`, `# ${name}\n`)),
      plainFile("workspace/AGENTS.md", "instructions\n"),
      ...(opts.extra ?? []),
    ],
    restartHash: opts.restartHash ?? "restart-1",
    filesHash: opts.filesHash ?? "files-1",
  };
}

const NONCE = "00112233aabbccdd";

describe("buildCreateContainerRequestBody", () => {
  it("builds the fixed template body for an allowed image and the configured network", () => {
    const body = buildCreateContainerRequestBody(spec(), CONFIG);
    expect(body).toEqual({
      Image: "myrmidon-hermes:1.1.0",
      Labels: {
        [BOT_LABEL_KEYS.bot]: "agent-a",
        [BOT_LABEL_KEYS.image]: "myrmidon-hermes:1.1.0",
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

  it("carries no profile-hash labels that could later be mistaken for applied state", () => {
    const labels = buildCreateContainerRequestBody(spec(), CONFIG).Labels;
    expect(Object.keys(labels).some((key) => key.includes("hash"))).toBe(false);
  });

  it("rejects an image outside the allowlist, a foreign network, an invalid key and non-positive limits", () => {
    expect(() => buildCreateContainerRequestBody(spec({ image: "evil/other:latest" }), CONFIG)).toThrow(BotContainerTemplateError);
    expect(() => buildCreateContainerRequestBody(spec({ network: "host" }), CONFIG)).toThrow(BotContainerTemplateError);
    expect(() => buildCreateContainerRequestBody(spec({ botKey: "../etc" }), CONFIG)).toThrow(BotContainerTemplateError);
    expect(() => buildCreateContainerRequestBody(spec({ memoryMb: 0 }), CONFIG)).toThrow(BotContainerTemplateError);
    expect(() => buildCreateContainerRequestBody(spec({ cpus: -1 }), CONFIG)).toThrow(BotContainerTemplateError);
    expect(() => buildCreateContainerRequestBody(spec({ pidsLimit: 0 }), CONFIG)).toThrow(BotContainerTemplateError);
  });
});

describe("containerTemplateDrifted", () => {
  const body = buildCreateContainerRequestBody(spec(), CONFIG);
  function matchingInspect(): { Config: { Image: string }; HostConfig: typeof body.HostConfig } {
    return { Config: { Image: body.Image }, HostConfig: { ...body.HostConfig } };
  }

  it("is false when every template field still matches", () => {
    expect(containerTemplateDrifted(matchingInspect(), body)).toBe(false);
  });

  type Inspect = ReturnType<typeof matchingInspect>;
  const mutations: Array<{ field: string; mutate: (e: Inspect) => void }> = [
    { field: "image", mutate: (e) => void (e.Config.Image = "myrmidon-hermes:0.9.0") },
    { field: "memory", mutate: (e) => void (e.HostConfig.Memory += 1) },
    { field: "cpus", mutate: (e) => void (e.HostConfig.NanoCpus += 1) },
    { field: "pidsLimit", mutate: (e) => void (e.HostConfig.PidsLimit += 1) },
    { field: "network", mutate: (e) => void (e.HostConfig.NetworkMode = "other") },
  ];
  for (const { field, mutate } of mutations) {
    it(`is true when the ${field} changed`, () => {
      const existing = matchingInspect();
      mutate(existing);
      expect(containerTemplateDrifted(existing, body)).toBe(true);
    });
  }
});

describe("botStateFromInspect", () => {
  it("takes health only from Docker's own health check, never from a probe", () => {
    expect(botStateFromInspect({ State: { Status: "running" } })).toBe("running"); // image without HEALTHCHECK
    expect(botStateFromInspect({ State: { Status: "running", Health: { Status: "starting" } } })).toBe("running");
    expect(botStateFromInspect({ State: { Status: "running", Health: { Status: "healthy" } } })).toBe("running");
    expect(botStateFromInspect({ State: { Status: "running", Health: { Status: "unhealthy" } } })).toBe("unhealthy");
  });

  it.each(["created", "exited", "restarting", "dead", "paused"])("reports %s as stopped", (status) => {
    expect(botStateFromInspect({ State: { Status: status } })).toBe("stopped");
  });
});

describe("buildHelperContainerRequestBody", () => {
  it("apply-profile: the bot's own uid, no capability, no network, the bot's three binds only", () => {
    const body = buildHelperContainerRequestBody({
      botKey: "agent-a",
      image: "sha256:abc",
      role: "apply-profile",
      script: "true",
      volumeRoot: CONFIG.volumeRoot,
    });
    expect(body.User).toBe(`${BOT_CONTAINER_UID}:${BOT_CONTAINER_UID}`);
    expect(body.HostConfig.CapDrop).toEqual(["ALL"]);
    expect(body.HostConfig.CapAdd).toEqual([]);
    expect(body.HostConfig.NetworkMode).toBe("none");
    expect(body.NetworkDisabled).toBe(true);
    expect(body.HostConfig.ReadonlyRootfs).toBe(true);
    expect(body.HostConfig.Privileged).toBe(false);
    expect(body.HostConfig.Binds).toEqual(buildCreateContainerRequestBody(spec(), CONFIG).HostConfig.Binds);
    expect(body.Entrypoint).toEqual(["/bin/sh", "-c"]);
    expect(body.Cmd).toEqual(["true", "myrmidon-helper", "/"]);
    expect(body.Labels).toEqual({ [BOT_LABEL_KEYS.helper]: "agent-a" }); // never listed as a bot
  });

  it("prepare-volumes: root, but with only CAP_CHOWN and CAP_FOWNER added back", () => {
    const body = buildHelperContainerRequestBody({
      botKey: "agent-a",
      image: "myrmidon-hermes:1.1.0",
      role: "prepare-volumes",
      script: buildPrepareVolumesScript(),
      volumeRoot: CONFIG.volumeRoot,
    });
    expect(body.User).toBe("0:0");
    expect(body.HostConfig.CapDrop).toEqual(["ALL"]);
    expect(body.HostConfig.CapAdd).toEqual(["CHOWN", "FOWNER"]);
    expect(body.HostConfig.NetworkMode).toBe("none");
  });
});

describe("buildProfileArchives", () => {
  const archives = buildProfileArchives(testProfile({ skills: [] }), { nonce: NONCE, removals: ["workspace/OLD.md"] });

  it("addresses only volume mount points, with entry paths relative to them — never the read-only root", () => {
    expect(archives.map((a) => a.mountPath)).toEqual(["/data/hermes", "/workspace"]);
    for (const archive of archives) {
      for (const entry of archive.entries) {
        expect(entry.path.startsWith("/")).toBe(false);
        expect(entry.path.split("/")).not.toContain("..");
        expect(entry.path.startsWith(`.myrmidon-next-${NONCE}`) || entry.path.startsWith(`.myrmidon-apply-${NONCE}`)).toBe(true);
      }
    }
  });

  it("gives every directory an explicit uid-10001, mode-0700 entry before anything inside it", () => {
    for (const archive of archives) {
      const seenDirs = new Set<string>();
      for (const entry of archive.entries) {
        const parent = path.posix.dirname(entry.path);
        if (parent !== ".") expect(seenDirs.has(parent)).toBe(true);
        if (entry.type === "directory") {
          expect([entry.uid, entry.gid, entry.mode]).toEqual([BOT_CONTAINER_UID, BOT_CONTAINER_UID, 0o700]);
          seenDirs.add(entry.path);
        } else {
          expect([entry.uid, entry.gid]).toEqual([BOT_CONTAINER_UID, BOT_CONTAINER_UID]);
        }
      }
    }
  });

  it("the same holds for the tar bytes actually PUT", () => {
    const parsed = parseUstarArchive(buildUstarArchive(archives[0].entries));
    const dirs = parsed.filter((e) => e.type === "directory");
    expect(dirs.map((d) => d.path)).toEqual(
      expect.arrayContaining([`.myrmidon-next-${NONCE}`, `.myrmidon-next-${NONCE}/hindsight`, `.myrmidon-apply-${NONCE}`]),
    );
    expect(dirs.every((d) => d.uid === BOT_CONTAINER_UID && d.mode === 0o700)).toBe(true);
    const firstFile = parsed.findIndex((e) => e.type === "file");
    expect(parsed.slice(firstFile).every((e) => e.type === "file")).toBe(true);
  });

  it("stages the compiler-owned skills directory even when the profile has no skills (that is what empties it)", () => {
    const hermes = archives[0].entries;
    expect(hermes.some((e) => e.type === "directory" && e.path === `.myrmidon-next-${NONCE}/skills-board`)).toBe(true);
  });

  it("writes secrets 0600 and carries the new marker and the removal list in the hermes archive", () => {
    const hermes = archives[0].entries;
    expect(hermes.find((e) => e.path === `.myrmidon-next-${NONCE}/.env`)?.mode).toBe(0o600);
    const marker = hermes.find((e) => e.path === `.myrmidon-apply-${NONCE}/applied.json`);
    expect(parseAppliedMarker(marker!.content.toString("utf8"))).toEqual({
      restartHash: "restart-1",
      filesHash: "files-1",
      files: ["hermes/.env", "hermes/config.yaml", "hermes/hindsight/config.json", "workspace/AGENTS.md"],
    });
    expect(hermes.find((e) => e.path === `.myrmidon-apply-${NONCE}/remove.list`)?.content.toString("utf8")).toBe("workspace/OLD.md\n");
  });

  const invalid: Array<{ label: string; extra: CompiledProfileFile[] }> = [
    { label: "an unsafe path", extra: [plainFile("hermes/../.myrmidon/applied.json", "{}")] },
    { label: "a reserved path", extra: [plainFile("hermes/.myrmidon/applied.json", "{}")] },
    { label: "a duplicate path", extra: [plainFile("workspace/AGENTS.md", "again")] },
    { label: "a file where the skills directory goes", extra: [plainFile("hermes/skills-board", "x")] },
    { label: "a path used both as a file and a directory", extra: [plainFile("workspace/AGENTS.md/x", "x")] },
  ];
  for (const { label, extra } of invalid) {
    it(`rejects ${label}`, () => {
      expect(() => buildProfileArchives(testProfile({ extra }), { nonce: NONCE, removals: [] })).toThrow(BotContainerTemplateError);
    });
  }

  it("rejects a nonce that is not plain hex", () => {
    expect(() => buildProfileArchives(testProfile(), { nonce: "../x", removals: [] })).toThrow(BotContainerTemplateError);
    expect(() => buildApplyScript("$(reboot)")).toThrow(BotContainerTemplateError);
  });
});

describe("computeProfileRemovals / parseAppliedMarker", () => {
  it("removes what the previous apply wrote and this profile no longer has, except under compiler-owned dirs", () => {
    const previous = [
      "hermes/config.yaml",
      "workspace/OLD.md",
      "hermes/skills-board/gone/SKILL.md",
      "hermes/../../etc/passwd", // the marker is bot-writable: never trusted
      "hermes/.myrmidon/applied.json",
    ];
    expect(computeProfileRemovals(previous, testProfile())).toEqual(["workspace/OLD.md"]);
    expect(computeProfileRemovals(undefined, testProfile())).toEqual([]);
  });

  it("reads only a well-formed marker", () => {
    expect(parseAppliedMarker('{"restartHash":"r","filesHash":"f","files":["hermes/a",7]}')).toEqual({
      restartHash: "r",
      filesHash: "f",
      files: ["hermes/a"],
    });
    expect(parseAppliedMarker('{"restartHash":"r","filesHash":"f"}')).toEqual({ restartHash: "r", filesHash: "f", files: [] });
    expect(parseAppliedMarker("not json")).toBeNull();
    expect(parseAppliedMarker('{"restartHash":"r"}')).toBeNull();
    expect(parseAppliedMarker("[]")).toBeNull();
  });
});

describe("demuxDockerLogs", () => {
  it("joins the payloads of Docker's multiplexed log frames", () => {
    const frame = (stream: number, text: string) => {
      const payload = Buffer.from(text, "utf8");
      const header = Buffer.alloc(8);
      header[0] = stream;
      header.writeUInt32BE(payload.length, 4);
      return Buffer.concat([header, payload]);
    };
    expect(demuxDockerLogs(Buffer.concat([frame(1, "out\n"), frame(2, "err\n")]))).toBe("out\nerr\n");
    expect(demuxDockerLogs(Buffer.from("plain text"))).toBe("plain text");
  });
});

// ---------------------------------------------------------------------------
// A fake Docker Engine on a unix socket. It reproduces the daemon rules the
// driver has to live with (moby v27):
//  - PUT /containers/{id}/archive into a path outside every volume of a
//    ReadonlyRootfs container is refused with 400 (daemon/archive_unix.go);
//  - extraction creates a missing parent directory as root:root 0755
//    (pkg/archive createImpliedDirectories), applies each entry's uid/gid/mode,
//    and refuses "../" breakouts;
//  - a missing bind source is created as root:root 0755 when volumes are mounted;
//  - a process can only change a directory it owns: the fake refuses to run a
//    non-root helper while any existing directory in its volumes belongs to
//    someone else — what `mv`/`rm` would hit as EACCES.
// Helper containers run their script for real with /bin/sh against the host
// directories (through a symlinked "container root"); `chown` is recorded by a
// shim instead of executed, since tests do not run as root.
// ---------------------------------------------------------------------------

interface FakeContainer {
  id: string;
  name: string;
  body: {
    Image: string;
    User?: string;
    Entrypoint?: string[];
    Cmd?: string[];
    Labels?: Record<string, string>;
    HostConfig: { Binds: string[]; ReadonlyRootfs?: boolean; Memory?: number; NanoCpus?: number; PidsLimit?: number; NetworkMode?: string };
  };
  state: "created" | "running" | "exited";
  health?: "starting" | "healthy" | "unhealthy";
  exitCode: number;
  logs: string;
}

interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  entries?: UstarReadEntry[];
}

interface Owner {
  uid: number;
  gid: number;
}

interface FakeDaemon {
  socketPath: string;
  containers: Map<string, FakeContainer>;
  owners: Map<string, Owner>;
  requests: RecordedRequest[];
  options: { healthOnStart: "starting" | "healthy" | "unhealthy" | null; failMarkerRead: boolean; bootNeedsProfile: boolean };
  close(): Promise<void>;
}

function imageIdFor(ref: string): string {
  return `sha256:${Buffer.from(ref, "utf8").toString("hex")}`;
}

function parseBinds(container: FakeContainer): Array<{ source: string; destination: string }> {
  return container.body.HostConfig.Binds.map((bind) => {
    const [source, destination] = bind.split(":");
    return { source, destination };
  });
}

function isInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(`${parent}/`);
}

async function startFakeDaemon(tmp: string, images: string[]): Promise<FakeDaemon> {
  const socketPath = path.join(tmp, "docker.sock");
  const containers = new Map<string, FakeContainer>();
  const owners = new Map<string, Owner>();
  const requests: RecordedRequest[] = [];
  const options: FakeDaemon["options"] = { healthOnStart: "healthy", failMarkerRead: false, bootNeedsProfile: true };
  const knownImages = new Set([...images, ...images.map(imageIdFor)]);
  const shimDir = path.join(tmp, "shim");
  const chownLog = path.join(tmp, "chown.log");
  fs.mkdirSync(shimDir, { recursive: true });
  fs.writeFileSync(path.join(shimDir, "chown"), '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$FAKE_CHOWN_LOG"\n', { mode: 0o755 });
  let seq = 0;

  function mountVolumes(container: FakeContainer): void {
    for (const { source } of parseBinds(container)) {
      if (!fs.existsSync(source)) {
        fs.mkdirSync(source, { recursive: true });
        owners.set(source, { uid: 0, gid: 0 });
      }
    }
  }

  function resolveInVolume(container: FakeContainer, absPath: string): string | null {
    const match = parseBinds(container)
      .filter(({ destination }) => isInside(absPath, destination))
      .sort((a, b) => b.destination.length - a.destination.length)[0];
    return match ? `${match.source}${absPath.slice(match.destination.length)}` : null;
  }

  function extract(target: string, entries: UstarReadEntry[]): string | null {
    for (const entry of entries) {
      const name = path.posix.normalize(entry.path);
      const dest = path.join(target, name);
      const rel = path.relative(target, dest);
      if (rel === ".." || rel.startsWith("../")) return `breakout: ${entry.path}`;
      const missing: string[] = [];
      for (let dir = path.dirname(dest); dir !== target && !fs.existsSync(dir); dir = path.dirname(dir)) missing.unshift(dir);
      for (const dir of missing) {
        fs.mkdirSync(dir);
        owners.set(dir, { uid: 0, gid: 0 }); // implied directory: root:root 0755
      }
      if (entry.type === "directory") {
        if (!fs.existsSync(dest)) fs.mkdirSync(dest);
      } else {
        fs.rmSync(dest, { recursive: true, force: true });
        fs.writeFileSync(dest, entry.content);
      }
      fs.chmodSync(dest, entry.mode);
      owners.set(dest, { uid: entry.uid, gid: entry.gid });
    }
    return null;
  }

  function runHelper(container: FakeContainer): void {
    mountVolumes(container);
    const uid = Number((container.body.User ?? "0").split(":")[0]);
    const sources = parseBinds(container).map((b) => b.source);
    if (uid !== 0) {
      for (const [dir, owner] of owners) {
        if (owner.uid === uid || !sources.some((source) => isInside(dir, source))) continue;
        if (!fs.existsSync(dir) || !fs.lstatSync(dir).isDirectory()) continue;
        container.exitCode = 1;
        container.logs = `Permission denied: ${dir} is owned by uid ${owner.uid}, the helper runs as uid ${uid}`;
        container.state = "exited";
        return;
      }
    }
    const view = path.join(tmp, `view-${++seq}`);
    for (const { source, destination } of parseBinds(container)) {
      const link = path.join(view, destination);
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.symlinkSync(source, link);
    }
    const [program, ...entryArgs] = container.body.Entrypoint ?? [];
    const cmd = [...(container.body.Cmd ?? [])];
    if (cmd.at(-1) === "/") cmd[cmd.length - 1] = view;
    fs.rmSync(chownLog, { force: true });
    const result = spawnSync(program, [...entryArgs, ...cmd], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${shimDir}:${process.env.PATH ?? ""}`, FAKE_CHOWN_LOG: chownLog },
    });
    if (fs.existsSync(chownLog)) {
      for (const line of fs.readFileSync(chownLog, "utf8").split("\n").filter(Boolean)) {
        const [ids, rel] = line.split(" ");
        const [u, g] = ids.split(":").map(Number);
        owners.set(fs.realpathSync(path.join(view, rel)), { uid: u, gid: g });
      }
    }
    container.exitCode = result.status ?? 1;
    container.logs = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    container.state = "exited";
  }

  function bootBot(container: FakeContainer): void {
    mountVolumes(container);
    if (options.bootNeedsProfile) {
      // What the bot image's entrypoint checks before the gateway starts.
      const binds = parseBinds(container);
      const notOwned = binds.find(({ source }) => owners.get(source)?.uid !== BOT_CONTAINER_UID);
      const hermes = binds.find(({ destination }) => destination === "/data/hermes");
      if (notOwned || !hermes || !fs.existsSync(path.join(hermes.source, "config.yaml"))) {
        container.state = "exited";
        container.exitCode = 1;
        container.logs = notOwned ? `${notOwned.destination} is not writable by uid ${BOT_CONTAINER_UID}` : "config.yaml missing";
        return;
      }
    }
    container.state = "running";
    container.health = options.healthOnStart ?? undefined;
  }

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url ?? "/", "http://docker");
    const route = url.pathname.replace(/^\/v1\.\d+/, "");
    const method = req.method ?? "GET";
    const query = Object.fromEntries(url.searchParams);
    const recorded: RecordedRequest = { method, path: decodeURIComponent(route), query };
    requests.push(recorded);
    const send = (status: number, body?: unknown) => {
      if (Buffer.isBuffer(body)) {
        res.writeHead(status, { "Content-Type": "application/x-tar" });
        res.end(body);
        return;
      }
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(body === undefined ? "" : JSON.stringify(body));
    };
    let m: RegExpMatchArray | null;

    if ((m = route.match(/^\/images\/(.+)\/json$/)) && method === "GET") {
      const ref = m[1].split("/").map(decodeURIComponent).join("/");
      return knownImages.has(ref) ? send(200, { Id: imageIdFor(ref) }) : send(404, { message: `No such image: ${ref}` });
    }
    if (route === "/containers/create" && method === "POST") {
      const name = query.name;
      const body = JSON.parse(raw.toString("utf8")) as FakeContainer["body"];
      if (containers.has(name)) return send(409, { message: `Conflict. The container name "${name}" is already in use` });
      if (!knownImages.has(body.Image)) return send(404, { message: `No such image: ${body.Image}` });
      containers.set(name, { id: `id-${++seq}`, name, body, state: "created", exitCode: 0, logs: "" });
      return send(201, { Id: `id-${seq}`, Warnings: [] });
    }
    if (route === "/containers/json" && method === "GET") {
      const wanted = (JSON.parse(query.filters ?? "{}") as { label?: string[] }).label ?? [];
      const list = [...containers.values()]
        .filter((c) => wanted.every((key) => c.body.Labels?.[key] !== undefined))
        .map((c) => ({ Id: c.id, Names: [`/${c.name}`], Labels: c.body.Labels ?? {} }));
      return send(200, list);
    }
    if (!(m = route.match(/^\/containers\/([^/]+)(?:\/([a-z]+))?$/))) return send(404, { message: "no such route" });
    const name = decodeURIComponent(m[1]);
    const action = m[2];
    const container = containers.get(name);
    if (!container) return send(404, { message: `No such container: ${name}` });

    if (!action && method === "DELETE") {
      if (container.state === "running" && query.force !== "true") return send(409, { message: "container is running" });
      containers.delete(name);
      return send(204);
    }
    if (action === "json" && method === "GET") {
      return send(200, {
        Id: container.id,
        Image: container.body.Image.startsWith("sha256:") ? container.body.Image : imageIdFor(container.body.Image),
        Config: { Image: container.body.Image, Labels: container.body.Labels ?? {}, User: container.body.User },
        State: {
          Status: container.state,
          ExitCode: container.exitCode,
          ...(container.health ? { Health: { Status: container.health } } : {}),
        },
        HostConfig: container.body.HostConfig,
      });
    }
    if (action === "start" && method === "POST") {
      if (container.state === "running") return send(304);
      if (container.body.Labels?.[BOT_LABEL_KEYS.helper]) runHelper(container);
      else bootBot(container);
      return send(204);
    }
    if (action === "stop" && method === "POST") {
      if (container.state !== "running") return send(304);
      container.state = "exited";
      container.health = undefined;
      return send(204);
    }
    if (action === "restart" && method === "POST") {
      bootBot(container);
      return send(204);
    }
    if (action === "wait" && method === "POST") return send(200, { StatusCode: container.exitCode });
    if (action === "rename" && method === "POST") {
      if (containers.has(query.name)) return send(409, { message: "name in use" });
      containers.delete(name);
      container.name = query.name;
      containers.set(query.name, container);
      return send(204);
    }
    if (action === "logs" && method === "GET") {
      const payload = Buffer.from(container.logs, "utf8");
      const header = Buffer.alloc(8);
      header[0] = 2;
      header.writeUInt32BE(payload.length, 4);
      return send(200, Buffer.concat([header, payload]));
    }
    if (action === "archive") {
      const absPath = query.path ?? "";
      const target = resolveInVolume(container, absPath);
      if (method === "PUT") {
        recorded.entries = parseUstarArchive(raw);
        if (!target) {
          return container.body.HostConfig.ReadonlyRootfs
            ? send(400, { message: "container rootfs is marked read-only" })
            : send(500, { message: "fake daemon: writes to a container's own filesystem are not modeled" });
        }
        mountVolumes(container);
        if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) return send(404, { message: `no such directory: ${absPath}` });
        const error = extract(target, recorded.entries);
        return error ? send(400, { message: error }) : send(200);
      }
      if (method === "GET") {
        if (options.failMarkerRead) return send(500, { message: "fake daemon: injected failure" });
        if (!target) return send(404, { message: "not modeled" });
        mountVolumes(container);
        if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return send(404, { message: `Could not find the file ${absPath}` });
        const owner = owners.get(target) ?? { uid: 0, gid: 0 };
        return send(
          200,
          buildUstarArchive([{ path: path.basename(target), content: fs.readFileSync(target), mode: 0o600, uid: owner.uid, gid: owner.gid }]),
        );
      }
    }
    return send(404, { message: `no such route: ${method} ${route}` });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    socketPath,
    containers,
    owners,
    requests,
    options,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Paths under `dir` (not following symlinks) whose name contains `needle`. */
function findNamed(dir: string, needle: string, depth = 16): string[] {
  const hits: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.name.includes(needle)) hits.push(full);
    if (entry.isDirectory() && depth > 1) hits.push(...findNamed(full, needle, depth - 1));
  }
  return hits;
}

function rawRequest(socketPath: string, method: string, requestPath: string, body?: Buffer): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method, path: requestPath }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

describe("dockerBotContainerDriver against a fake Docker daemon", () => {
  let tmp: string;
  let daemon: FakeDaemon;
  let driver: BotContainerDriver;
  let volumes: { hermes: string; workspace: string; scratch: string };
  let nonceSeq = 0;

  beforeEach(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "myr-bot-")));
    daemon = await startFakeDaemon(tmp, ["myrmidon-hermes:1.1.0", "myrmidon-hermes:1.2.0"]);
    const volumeRoot = path.join(tmp, "bots");
    volumes = {
      hermes: path.join(volumeRoot, "agent-a", "hermes"),
      workspace: path.join(volumeRoot, "agent-a", "workspace"),
      scratch: path.join(volumeRoot, "agent-a", "scratch"),
    };
    driver = dockerBotContainerDriver(
      { socketPath: daemon.socketPath, volumeRoot, network: "myrmidon-bots", allowlist: ["myrmidon-hermes:*"] },
      {
        sleep: async () => {},
        healthPollIntervalMs: 0,
        startHealthTimeoutMs: 200,
        nonce: () => `${(++nonceSeq).toString(16).padStart(8, "0")}cafef00d`,
      },
    );
  });

  afterEach(async () => {
    await daemon.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const read = (p: string) => fs.readFileSync(p, "utf8");
  const bot = () => daemon.containers.get("myrmidon-bot-agent-a");
  const leftovers = () =>
    Object.values(volumes).flatMap((dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => /^\.myrmidon-(next|apply|old)-/.test(n)) : []));

  it("reproduces Docker's rule the old driver hit: a PUT to '/' of a read-only-rootfs container is refused", async () => {
    await driver.create(spec());
    const res = await rawRequest(
      daemon.socketPath,
      "PUT",
      `/v1.45/containers/myrmidon-bot-agent-a/archive?path=${encodeURIComponent("/")}`,
      buildUstarArchive([{ path: "data/hermes/x", content: Buffer.from("x"), mode: 0o644, uid: 0, gid: 0 }]),
    );
    expect(res.status).toBe(400);
    expect(res.body).toContain("container rootfs is marked read-only");
  });

  it("first boot: volumes handed to uid 10001, profile laid down while stopped, gateway started only afterwards", async () => {
    await driver.create(spec());
    expect(bot()?.state).toBe("created"); // create never starts it
    await driver.writeProfile("agent-a", testProfile());
    expect(bot()?.state).toBe("created");
    await driver.start("agent-a");
    expect(bot()?.state).toBe("running"); // the fake entrypoint refused to boot without owned volumes + config.yaml

    // every archive went to a volume mount point, never to "/"
    const puts = daemon.requests.filter((r) => r.method === "PUT");
    expect(puts.length).toBeGreaterThan(0);
    for (const put of puts) expect(["/data/hermes", "/workspace", "/scratch"]).toContain(put.query.path);

    // ...and before the bot container was first started
    const firstBotStart = daemon.requests.findIndex((r) => r.method === "POST" && r.path === "/containers/myrmidon-bot-agent-a/start");
    const lastPut = daemon.requests.map((r) => r.method).lastIndexOf("PUT");
    expect(lastPut).toBeLessThan(firstBotStart);

    // volume roots: owned by the container uid, mode 0700
    for (const dir of Object.values(volumes)) {
      expect(daemon.owners.get(dir)).toEqual({ uid: BOT_CONTAINER_UID, gid: BOT_CONTAINER_UID });
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    }

    // files in place, secrets 0600, nothing left in staging
    expect(read(path.join(volumes.hermes, "config.yaml"))).toContain("example-model");
    expect(fs.statSync(path.join(volumes.hermes, ".env")).mode & 0o777).toBe(0o600);
    expect(read(path.join(volumes.hermes, "skills-board/skill-a/SKILL.md"))).toBe("# skill-a\n");
    expect(read(path.join(volumes.workspace, "AGENTS.md"))).toBe("instructions\n");
    expect(leftovers()).toEqual([]);

    // helpers are gone and never listed as bots
    expect([...daemon.containers.keys()]).toEqual(["myrmidon-bot-agent-a"]);
    expect((await driver.list()).map((s) => s.botKey)).toEqual(["agent-a"]);

    expect(await driver.status("agent-a")).toEqual({
      botKey: "agent-a",
      state: "running",
      image: "myrmidon-hermes:1.1.0",
      restartHash: "restart-1",
      filesHash: "files-1",
    });
  });

  it("the apply helper runs as uid 10001 with every directory it touches owned by 10001 (explicit tar directory entries)", async () => {
    await driver.create(spec());
    await driver.writeProfile("agent-a", testProfile());
    for (const put of daemon.requests.filter((r) => r.method === "PUT")) {
      const dirs = new Set(put.entries!.filter((e) => e.type === "directory").map((e) => e.path));
      for (const entry of put.entries!) {
        const parent = path.posix.dirname(entry.path);
        if (parent !== ".") expect(dirs.has(parent)).toBe(true); // no implied (root-owned) parent
        if (entry.type === "directory") expect([entry.uid, entry.mode]).toEqual([BOT_CONTAINER_UID, 0o700]);
      }
    }
    // The fake refuses to run a uid-10001 helper next to any root-owned
    // directory; a successful write is the proof nothing was left root-owned.
    expect(fs.existsSync(path.join(volumes.hermes, ".myrmidon/applied.json"))).toBe(true);
  });

  it("writes a new profile into a stopped container (no exec), and the marker follows", async () => {
    await driver.create(spec());
    await driver.writeProfile("agent-a", testProfile());
    await driver.writeProfile("agent-a", testProfile({ restartHash: "restart-2" }));
    expect(bot()?.state).toBe("created");
    expect(daemon.requests.some((r) => r.path.includes("/exec"))).toBe(false);
    const status = await driver.status("agent-a");
    expect([status.state, status.restartHash]).toEqual(["stopped", "restart-2"]);
  });

  it("revokes a skill and a dropped file, and leaves the bot's own files alone", async () => {
    await driver.create(spec());
    await driver.writeProfile("agent-a", testProfile({ skills: ["skill-a", "skill-b"], extra: [plainFile("workspace/OLD.md", "old\n")] }));
    fs.mkdirSync(path.join(volumes.hermes, "sessions"));
    fs.writeFileSync(path.join(volumes.hermes, "sessions/s1.json"), "{}"); // written by the bot itself
    fs.writeFileSync(path.join(volumes.workspace, "notes.txt"), "mine");
    expect(fs.existsSync(path.join(volumes.hermes, "skills-board/skill-b/SKILL.md"))).toBe(true);

    await driver.writeProfile("agent-a", testProfile({ skills: ["skill-a"], restartHash: "restart-2" }));
    expect(fs.existsSync(path.join(volumes.hermes, "skills-board/skill-b"))).toBe(false);
    expect(read(path.join(volumes.hermes, "skills-board/skill-a/SKILL.md"))).toBe("# skill-a\n");
    expect(fs.existsSync(path.join(volumes.workspace, "OLD.md"))).toBe(false);
    expect(read(path.join(volumes.hermes, "sessions/s1.json"))).toBe("{}");
    expect(read(path.join(volumes.workspace, "notes.txt"))).toBe("mine");
    expect(leftovers()).toEqual([]);

    await driver.writeProfile("agent-a", testProfile({ skills: [], restartHash: "restart-3" }));
    expect(fs.readdirSync(path.join(volumes.hermes, "skills-board"))).toEqual([]); // emptied, not left stale
  });

  it("never moves the staging of an interrupted earlier apply into place", async () => {
    await driver.create(spec());
    await driver.writeProfile("agent-a", testProfile());
    const stale = path.join(volumes.hermes, ".myrmidon-next-deadbeefdeadbeef");
    fs.mkdirSync(stale);
    fs.writeFileSync(path.join(stale, "config.yaml"), "stale: true\n");
    fs.mkdirSync(path.join(volumes.hermes, ".myrmidon-apply-deadbeefdeadbeef"));
    fs.writeFileSync(
      path.join(volumes.hermes, ".myrmidon-apply-deadbeefdeadbeef/applied.json"),
      '{"restartHash":"forged","filesHash":"forged"}',
    );

    await driver.writeProfile("agent-a", testProfile({ restartHash: "restart-2" }));
    expect(read(path.join(volumes.hermes, "config.yaml"))).toContain("example-model");
    expect(leftovers()).toEqual([]);
    expect((await driver.status("agent-a")).restartHash).toBe("restart-2");
  });

  it("moves the marker only after everything else: a failed apply keeps reporting the previous profile, and a retry converges", async () => {
    await driver.create(spec());
    await driver.writeProfile("agent-a", testProfile());
    // An obstacle the swap cannot move a file onto: a non-empty directory.
    fs.rmSync(path.join(volumes.workspace, "AGENTS.md"));
    fs.mkdirSync(path.join(volumes.workspace, "AGENTS.md"));
    fs.writeFileSync(path.join(volumes.workspace, "AGENTS.md/x"), "x");

    await expect(driver.writeProfile("agent-a", testProfile({ restartHash: "restart-2" }))).rejects.toThrow(/apply-profile helper/);
    expect((await driver.status("agent-a")).restartHash).toBe("restart-1");
    expect([...daemon.containers.keys()]).toEqual(["myrmidon-bot-agent-a"]); // failed helper removed too

    fs.rmSync(path.join(volumes.workspace, "AGENTS.md"), { recursive: true });
    await driver.writeProfile("agent-a", testProfile({ restartHash: "restart-2" }));
    expect((await driver.status("agent-a")).restartHash).toBe("restart-2");
    expect(leftovers()).toEqual([]);
  });

  it("treats profile paths as data: shell metacharacters in file names are written and removed literally", async () => {
    await driver.create(spec());
    const odd = '$(touch PWNED) `touch PWNED` "q" *.md';
    const extra = [plainFile(`workspace/${odd}`, "odd\n"), plainFile(`hermes/skills-board/x/${odd}`, "odd\n")];
    await driver.writeProfile("agent-a", testProfile({ extra }));
    expect(read(path.join(volumes.workspace, odd))).toBe("odd\n");
    expect(read(path.join(volumes.hermes, "skills-board/x", odd))).toBe("odd\n");
    await driver.writeProfile("agent-a", testProfile({ restartHash: "restart-2" })); // both dropped again
    expect(fs.existsSync(path.join(volumes.workspace, odd))).toBe(false);
    expect(fs.existsSync(path.join(volumes.hermes, "skills-board/x"))).toBe(false);
    expect(findNamed(tmp, "PWNED")).toEqual([]);
    expect(findNamed(process.cwd(), "PWNED", 1)).toEqual([]);
  });

  describe("status", () => {
    it("no marker means no hashes — never a fallback to what the container was created with", async () => {
      await driver.create(spec());
      const status = await driver.status("agent-a");
      expect(status.state).toBe("stopped");
      expect(status.restartHash).toBeUndefined();
      expect(status.filesHash).toBeUndefined();
    });

    it("a corrupt marker means no hashes", async () => {
      await driver.create(spec());
      await driver.writeProfile("agent-a", testProfile());
      fs.writeFileSync(path.join(volumes.hermes, ".myrmidon/applied.json"), "{not json");
      expect((await driver.status("agent-a")).restartHash).toBeUndefined();
    });

    it("a failed marker read is an error of the pass, not a guess", async () => {
      await driver.create(spec());
      daemon.options.failMarkerRead = true;
      await expect(driver.status("agent-a")).rejects.toThrow(/applied-state marker/);
    });

    it("reads the marker from the marker path inside the hermes volume", () => {
      expect(APPLIED_MARKER_CONTAINER_PATH).toBe("/data/hermes/.myrmidon/applied.json");
    });

    it("reports Docker's health verdict", async () => {
      await driver.create(spec());
      await driver.writeProfile("agent-a", testProfile());
      daemon.options.healthOnStart = "starting";
      await expect(driver.start("agent-a")).rejects.toThrow(/did not become healthy/);
      expect((await driver.status("agent-a")).state).toBe("running"); // still starting is not unhealthy
      bot()!.health = "unhealthy";
      expect((await driver.status("agent-a")).state).toBe("unhealthy");
    });
  });

  describe("start / restart", () => {
    it("start rejects when the container exits instead of becoming healthy", async () => {
      await driver.create(spec()); // no profile written: the fake entrypoint exits
      await expect(driver.start("agent-a")).rejects.toThrow(/exited \(exit code 1\)/);
    });

    it("restart is graceful (stop timeout) and waits for health", async () => {
      await driver.create(spec());
      await driver.writeProfile("agent-a", testProfile());
      await driver.start("agent-a");
      await driver.restart("agent-a");
      const restart = daemon.requests.find((r) => r.path === "/containers/myrmidon-bot-agent-a/restart");
      expect(restart?.query.t).toBe(String(BOT_STOP_TIMEOUT_SEC));
    });
  });

  describe("create / recreate", () => {
    it("create refuses an image the host does not have, before creating anything", async () => {
      await expect(driver.create(spec({ image: "myrmidon-hermes:9.9.9" }))).rejects.toThrow(/not present on the Docker host/);
      expect(daemon.containers.size).toBe(0);
    });

    it("recreate checks the new image first and leaves the running container untouched when it is missing", async () => {
      await driver.create(spec());
      await driver.writeProfile("agent-a", testProfile());
      await driver.start("agent-a");
      const before = daemon.requests.length;
      await expect(driver.recreate(spec({ image: "myrmidon-hermes:9.9.9" }))).rejects.toThrow(/not present on the Docker host/);
      const after = daemon.requests.slice(before);
      expect(after.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /images/myrmidon-hermes:9.9.9/json"]);
      expect(bot()?.state).toBe("running");
    });

    it("recreate builds the replacement first, stops the old one gracefully, swaps it in by rename, and leaves it stopped", async () => {
      await driver.create(spec());
      await driver.writeProfile("agent-a", testProfile());
      await driver.start("agent-a");
      const oldId = bot()!.id;
      expect(await driver.templateDrift(spec({ image: "myrmidon-hermes:1.2.0" }))).toBe(true);
      const before = daemon.requests.length;
      await driver.recreate(spec({ image: "myrmidon-hermes:1.2.0", memoryMb: 2048 }));

      const after = daemon.requests.slice(before);
      const at = (pred: (r: RecordedRequest) => boolean) => after.findIndex(pred);
      const createNext = at((r) => r.path === "/containers/create" && r.query.name === "myrmidon-bot-agent-a.next");
      const stopOld = at((r) => r.method === "POST" && r.path === "/containers/myrmidon-bot-agent-a/stop");
      const removeOld = at((r) => r.method === "DELETE" && r.path === "/containers/myrmidon-bot-agent-a");
      const rename = at((r) => r.path === "/containers/myrmidon-bot-agent-a.next/rename");
      expect(after[0]).toMatchObject({ method: "GET", path: "/images/myrmidon-hermes:1.2.0/json" });
      expect(createNext).toBeGreaterThan(0);
      expect(stopOld).toBeGreaterThan(createNext); // the old container is untouched until the new one exists
      expect(removeOld).toBeGreaterThan(stopOld); // stopped gracefully first, not force-killed
      expect(rename).toBeGreaterThan(removeOld);
      expect(after[stopOld].query.t).toBe(String(BOT_STOP_TIMEOUT_SEC));
      expect(after[rename].query.name).toBe("myrmidon-bot-agent-a");

      expect(bot()?.id).not.toBe(oldId);
      expect(bot()?.state).toBe("created");
      expect(bot()?.body.Image).toBe("myrmidon-hermes:1.2.0");
      expect(await driver.templateDrift(spec({ image: "myrmidon-hermes:1.2.0", memoryMb: 2048 }))).toBe(false);
      // the volumes (and with them the applied profile) survive the recreate
      expect((await driver.status("agent-a")).restartHash).toBe("restart-1");
    });

    it("recreate clears a replacement left behind by an interrupted earlier recreate", async () => {
      await driver.create(spec());
      daemon.containers.set("myrmidon-bot-agent-a.next", {
        ...bot()!,
        id: "stale",
        name: "myrmidon-bot-agent-a.next",
      });
      await driver.recreate(spec({ image: "myrmidon-hermes:1.2.0" }));
      expect([...daemon.containers.keys()]).toEqual(["myrmidon-bot-agent-a"]);
      expect(bot()?.body.Image).toBe("myrmidon-hermes:1.2.0");
    });
  });

  it("refuses to write another bot's profile", async () => {
    await driver.create(spec());
    await expect(driver.writeProfile("agent-a", testProfile({ botKey: "agent-b" }))).rejects.toThrow(BotContainerTemplateError);
  });
});
