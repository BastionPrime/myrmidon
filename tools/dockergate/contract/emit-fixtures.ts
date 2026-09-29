// tools/dockergate/contract/emit-fixtures.ts
//
// Contract between the bot-container driver (TypeScript) and dockergate (Go).
// Imports the driver modules of the SAME commit and writes reference fixtures
// that the Go tests compare against byte for byte:
//   scripts/   buildPrepareVolumesScript() and buildApplyScript(N) for several N
//   bodies/    create bodies of all three forms, incl. fractional cpus/memory
//   archives/  buildProfileArchives() output (fixed mtime)
//   traffic.json  raw requests the real driver sends to a fake daemon over a
//                 unix socket (create -> writeProfile -> start -> status ->
//                 writeProfile -> restart -> recreate -> writeProfile -> start)
//   manifest.json index of the above
//
// Usage (from the repository root, after `pnpm install`):
//   pnpm --filter @paperclipai/server exec tsx ../tools/dockergate/contract/emit-fixtures.ts <out-dir>
// The checked-in fixtures live in tools/dockergate/contract/testdata; regenerate
// them with this script whenever the driver surface changes.

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  buildApplyScript,
  buildCreateContainerRequestBody,
  buildHelperContainerRequestBody,
  buildPrepareVolumesScript,
  buildProfileArchives,
  dockerBotContainerDriver,
  serializeAppliedMarker,
} from "../../../server/src/myrmidon/bot-containers/docker-driver.js";
import { buildUstarArchive, parseUstarArchive } from "../../../server/src/myrmidon/bot-containers/ustar.js";
import type { CompiledProfile } from "../../../server/src/myrmidon/bot-containers/types.js";

const outDir = process.argv[2];
if (!outDir) {
  console.error("usage: emit-fixtures <out-dir>");
  process.exit(2);
}

const VOLUME_ROOT = "/srv/myrmidon-bots";
const NETWORK = "myrmidon-bots";
const BOT_KEY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const IMAGE = `ghcr.io/itkadr-git/myrmidon-hermes@sha256:${"0123456789abcdef".repeat(4)}`;
const IMAGE_ID = `sha256:${"fedcba9876543210".repeat(4)}`;
const NONCES = ["0123456789abcdef", "fedcba9876543210", "00000000ffffffff", "a1b2c3d4e5f60718", "9999999999999999"];
const MTIME = new Date(1_780_000_000_000);

function write(rel: string, data: string | Buffer): void {
  const file = path.join(outDir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}

const config = { socketPath: "", volumeRoot: VOLUME_ROOT, network: NETWORK, allowlist: [IMAGE] };

const manifest: {
  botKey: string;
  image: string;
  imageId: string;
  volumeRoot: string;
  network: string;
  nonces: string[];
  bodies: Array<Record<string, unknown>>;
  archives: Array<Record<string, unknown>>;
} = { botKey: BOT_KEY, image: IMAGE, imageId: IMAGE_ID, volumeRoot: VOLUME_ROOT, network: NETWORK, nonces: NONCES, bodies: [], archives: [] };

// ---- scripts ----
write("scripts/prepare.sh", buildPrepareVolumesScript());
for (const nonce of NONCES) write(`scripts/apply-${nonce}.sh`, buildApplyScript(nonce));

// ---- create bodies ----
const specs = [
  { id: "bot-plain", memoryMb: 1024, cpus: 1, pidsLimit: 512 },
  { id: "bot-fractional-cpus", memoryMb: 768, cpus: 0.25, pidsLimit: 256 },
  { id: "bot-fractional-both", memoryMb: 1536.5, cpus: 2.3, pidsLimit: 1024 },
  { id: "bot-tenth", memoryMb: 512, cpus: 0.1, pidsLimit: 64 },
];
for (const spec of specs) {
  for (const suffix of ["", ".next"]) {
    const body = buildCreateContainerRequestBody(
      { botKey: BOT_KEY, image: IMAGE, memoryMb: spec.memoryMb, cpus: spec.cpus, pidsLimit: spec.pidsLimit, network: NETWORK },
      config,
    );
    const id = `${spec.id}${suffix ? "-next" : ""}`;
    write(`bodies/${id}.json`, JSON.stringify(body));
    manifest.bodies.push({ id, form: "bot", name: `myrmidon-bot-${BOT_KEY}${suffix}`, file: `bodies/${id}.json`, ...spec });
  }
}
for (const image of [IMAGE, IMAGE_ID]) {
  write(`bodies/helper-prepare${image === IMAGE ? "" : "-by-id"}.json`, JSON.stringify(
    buildHelperContainerRequestBody({ botKey: BOT_KEY, image, role: "prepare-volumes", script: buildPrepareVolumesScript(), volumeRoot: VOLUME_ROOT }),
  ));
  manifest.bodies.push({
    id: `helper-prepare${image === IMAGE ? "" : "-by-id"}`,
    form: "helper-prepare",
    name: `myrmidon-bot-${BOT_KEY}.helper`,
    file: `bodies/helper-prepare${image === IMAGE ? "" : "-by-id"}.json`,
    image,
  });
}
for (const nonce of NONCES) {
  write(`bodies/helper-apply-${nonce}.json`, JSON.stringify(
    buildHelperContainerRequestBody({ botKey: BOT_KEY, image: IMAGE_ID, role: "apply-profile", script: buildApplyScript(nonce), volumeRoot: VOLUME_ROOT }),
  ));
  manifest.bodies.push({
    id: `helper-apply-${nonce}`,
    form: "helper-apply",
    name: `myrmidon-bot-${BOT_KEY}.helper`,
    file: `bodies/helper-apply-${nonce}.json`,
    image: IMAGE_ID,
    nonce,
  });
}

// ---- profile archives ----
function profile(hashes: { restart: string; files: string }, extra: CompiledProfile["files"] = []): CompiledProfile {
  return {
    botKey: BOT_KEY,
    restartHash: hashes.restart,
    filesHash: hashes.files,
    files: [
      { path: "hermes/config.yaml", content: "model: example\n", mode: 0o644, secret: false },
      { path: "hermes/.env", content: 'API_SERVER_KEY="placeholder"\n', mode: 0o644, secret: true },
      { path: "workspace/AGENTS.md", content: "# Agent\n", mode: 0o644, secret: false },
      { path: "hermes/skills-board/alpha/SKILL.md", content: "---\nname: alpha\n---\n", mode: 0o644, secret: false },
      { path: "hermes/skills-board/beta.md", content: "beta\n", mode: 0o644, secret: false },
      { path: "scratch/notes/a/b/c.txt", content: "x", mode: 0o600, secret: false },
      { path: `hermes/${"d".repeat(60)}/${"e".repeat(60)}/${"f".repeat(60)}.txt`, content: "long path\n", mode: 0o644, secret: false },
      ...extra,
    ],
  };
}
const archiveCases: Array<{ id: string; profile: CompiledProfile; removals: string[]; nonce: string }> = [
  { id: "full", profile: profile({ restart: "r".repeat(8), files: "f".repeat(8) }), removals: ["workspace/old.txt", "hermes/gone.yaml"], nonce: NONCES[0]! },
  { id: "minimal", profile: { botKey: BOT_KEY, restartHash: "r1", filesHash: "f1", files: [] }, removals: [], nonce: NONCES[1]! },
];
for (const c of archiveCases) {
  const archives = buildProfileArchives(c.profile, { nonce: c.nonce, removals: c.removals, mtime: MTIME });
  for (const archive of archives) {
    const seg = archive.mountPath.replace(/^\//, "").replace(/\//g, "_");
    const file = `archives/${c.id}-${seg}.tar`;
    write(file, buildUstarArchive(archive.entries));
    manifest.archives.push({ id: c.id, mountPath: archive.mountPath, nonce: c.nonce, mtime: MTIME.getTime() / 1000, file });
  }
  write(`archives/${c.id}-applied.json`, serializeAppliedMarker(c.profile));
}

// ---- recorded traffic against a fake daemon ----
interface Recorded {
  step: string;
  method: string;
  target: string;
  headers: Record<string, string | string[] | undefined>;
  bodyBase64: string;
}
const recorded: Recorded[] = [];
let step = "init";

interface FakeContainer {
  id: string;
  name: string;
  image: string;
  labels: Record<string, string>;
  memory: number;
  status: "created" | "running" | "exited";
  marker?: Buffer;
}
const containers = new Map<string, FakeContainer>();
let counter = 0;

function inspectJson(c: FakeContainer): string {
  return JSON.stringify({
    Id: c.id,
    Image: IMAGE_ID,
    Name: `/${c.name}`,
    Config: { Image: IMAGE, Labels: c.labels, Env: ["PATH=/usr/local/bin:/usr/bin", "SECRET_CANARY=must-not-leak"] },
    State: { Status: c.status, ExitCode: 0, Health: { Status: "healthy" } },
    HostConfig: { Memory: c.memory, NanoCpus: 1_000_000_000, PidsLimit: 512, NetworkMode: NETWORK },
  });
}

function findContainer(ref: string): FakeContainer | undefined {
  for (const c of containers.values()) if (c.name === ref || c.id === ref) return c;
  return undefined;
}

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    recorded.push({ step, method: req.method ?? "", target: req.url ?? "", headers: { ...req.headers }, bodyBase64: body.toString("base64") });
    const url = new URL(req.url ?? "/", "http://docker");
    const send = (status: number, payload?: string | Buffer, type = "application/json") => {
      const data = payload === undefined ? Buffer.alloc(0) : Buffer.from(payload);
      res.writeHead(status, { "Content-Type": type, "Content-Length": String(data.length) });
      res.end(data);
    };
    const parts = url.pathname.split("/").filter(Boolean); // v1.45, containers, <ref>, <action>
    if (parts[1] === "images" && parts[parts.length - 1] === "json") {
      return send(200, JSON.stringify({ Id: IMAGE_ID, Config: { Labels: { "myrmidon.bot-runtime.contract": "1" }, User: "10001:10001", Env: ["PATH=/usr/local/bin:/usr/bin"] } }));
    }
    if (parts[1] !== "containers") return send(404, JSON.stringify({ message: "not found" }));
    if (parts[2] === "create") {
      const name = url.searchParams.get("name") ?? "";
      const parsed = JSON.parse(body.toString("utf8")) as { Image: string; Labels: Record<string, string>; HostConfig: { Memory: number } };
      counter += 1;
      const id = counter.toString(16).padStart(64, "0");
      containers.set(id, { id, name, image: parsed.Image, labels: parsed.Labels, memory: parsed.HostConfig.Memory, status: "created" });
      return send(201, JSON.stringify({ Id: id, Warnings: [] }));
    }
    const ref = decodeURIComponent(parts[2] ?? "");
    const c = findContainer(ref);
    const action = parts[3];
    if (req.method === "DELETE" && parts.length === 3) {
      if (!c) return send(404, JSON.stringify({ message: "no such container" }));
      containers.delete(c.id);
      return send(204);
    }
    if (!c) return send(404, JSON.stringify({ message: "no such container" }));
    switch (action) {
      case "json":
        return send(200, inspectJson(c));
      case "archive":
        if (req.method === "GET") {
          if (!c.marker) return send(404, JSON.stringify({ message: "not found" }));
          return send(200, c.marker, "application/x-tar");
        } else {
          // PUT: remember the applied marker of the latest apply, as the real helper would move it into place.
          if (url.searchParams.get("path") === "/data/hermes") {
            const marker = parseUstarArchive(body).find((entry) => /\/applied\.json$/.test(entry.path));
            if (marker) {
              const target = [...containers.values()].find((x) => x.labels["myrmidon.bot"] === c.labels["myrmidon.bot-helper"] && !x.name.endsWith(".helper"));
              if (target) target.marker = buildUstarArchive([{ path: "applied.json", content: marker.content, mode: 0o600, uid: 10001, gid: 10001 }]);
              else pendingMarker = buildUstarArchive([{ path: "applied.json", content: marker.content, mode: 0o600, uid: 10001, gid: 10001 }]);
            }
          }
          return send(200, "");
        }
      case "start":
        if (c.status === "running") return send(304);
        c.status = c.name.endsWith(".helper") ? "exited" : "running";
        if (c.name.endsWith(".helper") && pendingMarker) {
          const target = [...containers.values()].find((x) => x.labels["myrmidon.bot"] === c.labels["myrmidon.bot-helper"] && !x.name.endsWith(".helper"));
          if (target) {
            target.marker = pendingMarker;
            pendingMarker = undefined;
          }
        }
        return send(204);
      case "wait":
        return send(200, JSON.stringify({ StatusCode: 0 }));
      case "stop":
        c.status = "exited";
        return send(204);
      case "restart":
        c.status = "running";
        return send(204);
      case "rename":
        c.name = url.searchParams.get("name") ?? c.name;
        return send(204);
      default:
        return send(404, JSON.stringify({ message: "not found" }));
    }
  });
});
let pendingMarker: Buffer | undefined;

const sockDir = fs.mkdtempSync(path.join(os.tmpdir(), "dockergate-contract-"));
const sockPath = path.join(sockDir, "docker.sock");
await new Promise<void>((resolve) => server.listen(sockPath, resolve));

let nonceIndex = 0;
const driver = dockerBotContainerDriver(
  { ...config, socketPath: sockPath },
  { sleep: async () => {}, healthPollIntervalMs: 0, nonce: () => NONCES[nonceIndex++ % NONCES.length]! },
);
const baseSpec = { botKey: BOT_KEY, image: IMAGE, memoryMb: 1024, cpus: 1, pidsLimit: 512, network: NETWORK };
const p1 = profile({ restart: "r1r1r1r1", files: "f1f1f1f1" });
const p2 = profile({ restart: "r1r1r1r1", files: "f2f2f2f2" }, [{ path: "workspace/extra.md", content: "extra\n", mode: 0o644, secret: false }]);
const p3 = profile({ restart: "r3r3r3r3", files: "f3f3f3f3" });

step = "create";
await driver.create(baseSpec);
step = "writeProfile-1";
await driver.writeProfile(BOT_KEY, p1);
step = "start";
await driver.start(BOT_KEY);
step = "status";
await driver.status(BOT_KEY);
step = "writeProfile-files";
await driver.writeProfile(BOT_KEY, p2);
step = "restart";
await driver.restart(BOT_KEY);
step = "recreate";
await driver.recreate({ ...baseSpec, memoryMb: 2048 });
step = "writeProfile-3";
await driver.writeProfile(BOT_KEY, p3);
step = "start-after-recreate";
await driver.start(BOT_KEY);

write("traffic.json", `${JSON.stringify(recorded, null, 1)}\n`);
write("manifest.json", `${JSON.stringify(manifest, null, 1)}\n`);
server.close();
fs.rmSync(sockDir, { recursive: true, force: true });
console.error(`emitted ${recorded.length} recorded requests, ${manifest.bodies.length} bodies, ${manifest.archives.length} archives into ${outDir}`);
