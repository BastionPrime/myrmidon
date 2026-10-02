// myrmidon(EXTCASE-B): live bridge connections.
//
// The gateway holds one session per connected device, so two things can be
// answered without touching the socket layer: "is this device reachable?" (a bot
// action against an offline device must fail fast with -32014, not wait 30 s)
// and "drop this device now" (revocation is fail-closed: the panel deletes the
// record and any open connection is closed in the same step, so an already
// authenticated socket cannot keep acting on a revoked token).

import type { BrowserBridgeCapability, BrowserBridgeMethod } from "@paperclipai/shared";

export interface BridgeSession {
  readonly deviceId: string;
  readonly companyId: string;
  readonly extVersion: string;
  readonly capabilities: BrowserBridgeCapability[];
  readonly connectedAt: number;
  /** Perform one action on the device; rejects with a BridgeError on timeout/refusal. */
  request(method: BrowserBridgeMethod, params: unknown, timeoutMs: number): Promise<unknown>;
  close(code: number, reason: string): void;
}

export class InMemoryBridgeSessionRegistry {
  private readonly sessions = new Map<string, BridgeSession>();

  register(session: BridgeSession): void {
    // A device reconnecting replaces its previous session: the extension opens
    // exactly one socket, and a stale one must not keep receiving actions.
    const previous = this.sessions.get(session.deviceId);
    if (previous && previous !== session) {
      previous.close(1000, "replaced by a newer connection");
    }
    this.sessions.set(session.deviceId, session);
  }

  unregister(session: BridgeSession): void {
    const current = this.sessions.get(session.deviceId);
    if (current === session) this.sessions.delete(session.deviceId);
  }

  get(deviceId: string): BridgeSession | undefined {
    return this.sessions.get(deviceId);
  }

  isConnected(deviceId: string): boolean {
    return this.sessions.has(deviceId);
  }

  /** Close and forget one device's connection; true when there was one. */
  disconnect(deviceId: string, reason: string): boolean {
    const session = this.sessions.get(deviceId);
    if (!session) return false;
    this.sessions.delete(deviceId);
    session.close(1008, reason);
    return true;
  }

  disconnectCompany(companyId: string, reason: string): number {
    let closed = 0;
    for (const [deviceId, session] of [...this.sessions.entries()]) {
      if (session.companyId !== companyId) continue;
      this.sessions.delete(deviceId);
      session.close(1008, reason);
      closed += 1;
    }
    return closed;
  }

  size(): number {
    return this.sessions.size;
  }
}