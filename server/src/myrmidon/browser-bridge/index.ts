// myrmidon(EXTCASE-B): wiring of the browser bridge into the server.
//
// One runtime per process, memoized here: the WSS session registry is in-process
// state by nature (a socket lives in this process), and both the app's routes and
// the HTTP server's upgrade hook must reach the same registry — otherwise the
// panel would list a device whose revocation cannot find its socket.
//
// The HMAC pepper of pairing codes and bridge tokens comes from
// `MYRMIDON_BROWSER_BRIDGE_PEPPER`. Without it the process derives a random
// per-start pepper and logs a warning: everything issued before a restart stops
// verifying and the extension re-pairs. That is the fail-closed default — the
// alternative (a constant compiled into the source) would let anyone holding the
// image forge token digests. A deployment that wants durable pairings sets the
// variable; it belongs in the environment, not in the settings row the panel can
// read and edit.

import { randomBytes } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import type { Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { logActivity } from "../../services/activity-log.js";
import { instanceSettingsService } from "../../services/instance-settings.js";
import { secretService } from "../../services/secrets.js";
import { IdempotencyCache } from "./jsonrpc.js";
import { browserBridgePanelRoutes, browserBridgePublicRoutes } from "./routes.js";
import { InMemoryBridgeSessionRegistry } from "./sessions.js";
import { browserBridgeService, type BrowserBridgeService } from "./service.js";
import {
  InMemoryBridgeDeviceStore,
  SecretBackedBridgeDeviceStore,
  type BridgeDeviceStore,
  type BridgeSecretPort,
} from "./store.js";
import { InMemoryPairingCodeStore } from "./store.js";
import { dispatchBridgeAction, setupBrowserBridgeWebSocketServer } from "./wss.js";

export interface BrowserBridgeRuntime {
  service: BrowserBridgeService;
  sessions: InMemoryBridgeSessionRegistry;
  idempotency: IdempotencyCache;
}

/** The board's secret service behind the narrow port the device store needs. */
export function bridgeSecretPort(db: Db): BridgeSecretPort {
  const secrets = secretService(db);
  return {
    list: async (companyId) => {
      const rows = await secrets.list(companyId);
      return rows.map((row) => ({
        id: row.id,
        key: row.key,
        name: row.name,
        description: row.description ?? null,
        providerMetadata: (row.providerMetadata ?? null) as Record<string, unknown> | null,
        status: row.status,
      }));
    },
    create: (companyId, input) =>
      secrets.create(
        companyId,
        {
          name: input.name,
          key: input.key,
          description: input.description,
          providerMetadata: input.providerMetadata,
          value: input.value,
          provider: "local_encrypted",
        },
        input.actor,
      ),
    update: (secretId, patch) => secrets.update(secretId, patch),
    remove: (secretId) => secrets.remove(secretId),
  };
}

/**
 * Build the runtime. Tests pass their own ports; the server takes the defaults:
 * pairing codes in memory (short-lived, one-shot), device records in the board's
 * secret storage (durable, revocable).
 */
export function createBrowserBridgeRuntime(
  db: Db,
  overrides: {
    pepper?: string;
    sessions?: InMemoryBridgeSessionRegistry;
    idempotency?: IdempotencyCache;
    devices?: BridgeDeviceStore;
  } = {},
): BrowserBridgeRuntime {
  const settings = instanceSettingsService(db);
  const sessions = overrides.sessions ?? new InMemoryBridgeSessionRegistry();
  const idempotency = overrides.idempotency ?? new IdempotencyCache();

  let pepper = overrides.pepper ?? process.env.MYRMIDON_BROWSER_BRIDGE_PEPPER?.trim();
  if (!pepper) {
    pepper = randomBytes(32).toString("hex");
    logger.warn(
      "MYRMIDON_BROWSER_BRIDGE_PEPPER is not set; a random per-start pepper is used and every paired device must pair again after a restart",
    );
  }

  const service = browserBridgeService({
    pairings: new InMemoryPairingCodeStore(),
    devices: overrides.devices ?? new SecretBackedBridgeDeviceStore(bridgeSecretPort(db)),
    sessions,
    settings: {
      getGeneral: () => settings.getGeneral(),
      updateGeneral: (patch) => settings.updateGeneral(patch),
    },
    listCompanyIds: () => settings.listCompanyIds(),
    logActivity: (entry) => logActivity(db, entry),
    pepper,
    dispatch: (input) =>
      dispatchBridgeAction({
        sessions,
        idempotency,
        deviceId: input.deviceId,
        method: input.method,
        params: input.params,
        timeoutMs: input.timeoutMs,
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      }),
  });
  return { service, sessions, idempotency };
}

let sharedRuntime: BrowserBridgeRuntime | null = null;

/** Process-wide runtime, created on first use. */
export function browserBridgeRuntime(db: Db): BrowserBridgeRuntime {
  if (!sharedRuntime) sharedRuntime = createBrowserBridgeRuntime(db);
  return sharedRuntime;
}

/** Board panel router for app.ts (`/api/myrmidon/browser-bridge/...`). */
export function myrmidonBrowserBridgeRoutes(db: Db) {
  return browserBridgePanelRoutes(() => browserBridgeRuntime(db).service);
}

/** Extension-facing router for app.ts (`POST /bridge/v1/pair`). */
export function myrmidonBrowserBridgePublicRoutes(db: Db) {
  return browserBridgePublicRoutes(() => browserBridgeRuntime(db).service);
}

/** Attach the WSS endpoint to the shared HTTP server. */
export function startBrowserBridge(db: Db, server: HttpServer): void {
  const runtime = browserBridgeRuntime(db);
  setupBrowserBridgeWebSocketServer(server, runtime.service, {
    sessions: runtime.sessions,
    logActivity: (entry) => logActivity(db, entry),
  });
}

export { InMemoryBridgeDeviceStore, InMemoryPairingCodeStore, SecretBackedBridgeDeviceStore };
export { browserBridgeService, dispatchBridgeAction, setupBrowserBridgeWebSocketServer };
export type { BrowserBridgeService, BridgeDeviceStore, BridgeSecretPort };