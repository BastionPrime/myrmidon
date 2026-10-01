// myrmidon(CLOUD-CONNECTOR): the service.
//
// One process-wide service holds the accounts, the roots, the grants and the
// journal (store.ts) and is the only place that turns a request into a
// provider call. The enforcement is deliberately narrow: resolve the named
// root for this agent, pick the most specific grant, check the mode, confine
// the path to the root, then call the provider. Every attempt — allowed or
// refused — is journalled, which is what the acceptance case checks.

import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import type {
  CloudAccessMode,
  CloudAccount,
  CloudGrant,
  CloudJournalEntry,
  CloudProviderId,
  CloudResolvedAccess,
  CloudRoot,
  CloudToolCall,
  CloudToolResult,
} from "@paperclipai/shared/myrmidon-cloud-connector";
import { CloudConnectorError, type CloudAgentIdentity, type CloudListing } from "./types.js";
import { splitCloudPath } from "./paths.js";
import {
  allowsWrite,
  assertModeAllowedForRoot,
  outsideGrantMessage,
  personalRootFolder,
  personalRootName,
  readOnlyMessage,
  resolveAccess,
  resolveNamedRoot,
} from "./grants.js";
import type { CloudProviderRegistry } from "./providers/provider.js";
import {
  CLOUD_OAUTH_SPECS,
  buildAuthorizeUrl,
  createCodeVerifier,
  exchangeCode,
  serializeTokenBundle,
  type OAuthClient,
  type OAuthProviderSpec,
  type OAuthStateStore,
} from "./oauth.js";
import type { CloudTokenStore } from "./token-store.js";
import {
  appendJournal,
  dbCloudConnectorStore,
  type CloudConnectorDocument,
  type CloudConnectorStore,
} from "./store.js";

/** Read this many bytes into memory for a text read; larger files need download. */
export const CLOUD_READ_LIMIT_BYTES = 200_000;
/** Hard ceiling for a single download through the connector. */
export const CLOUD_DOWNLOAD_LIMIT_BYTES = 64 * 1024 * 1024;

export interface CloudConnectorServiceDeps {
  /** Production wiring passes the database; tests pass `store` instead. */
  db?: Db;
  providers: CloudProviderRegistry;
  store?: CloudConnectorStore;
  /** Present when the owner can connect an account through OAuth (part B). */
  oauth?: CloudOAuthDeps;
  now?: () => number;
  newId?: () => string;
}

export interface CloudOAuthDeps {
  clients: Partial<Record<CloudProviderId, OAuthClient>>;
  stateStore: OAuthStateStore;
  tokenStore: CloudTokenStore;
  specs?: Record<CloudProviderId, OAuthProviderSpec>;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface CreateAccountInput {
  providerId: CloudProviderId;
  displayName: string;
  companyId: string;
  tokenRef: string;
  scopes?: string[];
}

export interface BeginConnectInput {
  providerId: CloudProviderId;
  companyId: string;
  userId: string;
  displayName?: string;
}

export interface CreateRootInput {
  providerId: CloudProviderId;
  companyId: string;
  name: string;
  kind: "own" | "shared";
  description?: string;
  driveId?: string;
  itemId?: string;
  folder?: string;
}

export interface SetGrantInput {
  rootId: string;
  targetKind: "agent" | "caste" | "all";
  agentId?: string;
  caste?: string;
  mode: CloudAccessMode;
}

/** Secret name and key the connector uses for one provider's token bundle. */
function accountSecretNaming(providerId: CloudProviderId): { name: string; key: string } {
  return {
    name: `myrmidon-cloud-${providerId}`,
    key: `myrmidon_cloud_${providerId.replace(/-/g, "_")}`,
  };
}

export class CloudConnectorService {
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly deps: CloudConnectorServiceDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.newId = deps.newId ?? (() => randomUUID());
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  private store(): CloudConnectorStore {
    const store = this.deps.store;
    if (store) return store;
    if (!this.deps.db) throw new Error("cloud connector needs a store or a database");
    return dbCloudConnectorStore(this.deps.db);
  }

  private async document(): Promise<CloudConnectorDocument> {
    return this.store().read();
  }

  // -- accounts -------------------------------------------------------------

  private oauth(): CloudOAuthDeps {
    const oauth = this.deps.oauth;
    if (!oauth) throw new CloudConnectorError(409, "connecting a cloud account is not configured on this instance");
    return oauth;
  }

  async listAccounts(companyId?: string): Promise<CloudAccount[]> {
    const accounts = (await this.document()).accounts;
    return companyId ? accounts.filter((account) => account.companyId === companyId) : accounts;
  }

  /**
   * Owner starts a connect: the connector answers the provider URL to open and
   * remembers a single-use state that ties the callback to this owner.
   */
  async beginConnect(input: BeginConnectInput): Promise<{ providerId: CloudProviderId; authorizeUrl: string; state: string }> {
    if (!this.deps.providers.has(input.providerId)) {
      throw new CloudConnectorError(400, `unknown cloud provider "${input.providerId}"`);
    }
    const oauth = this.oauth();
    const spec = (oauth.specs ?? CLOUD_OAUTH_SPECS)[input.providerId];
    const client = oauth.clients[input.providerId];
    if (!client) throw new CloudConnectorError(409, `${spec.displayName} is not configured on this instance`);
    if (!client.redirectUri.startsWith("http")) {
      throw new CloudConnectorError(409, "the connector callback address is not configured on this instance");
    }
    const verifier = spec.usePkce ? createCodeVerifier() : null;
    const state = oauth.stateStore.issue({
      providerId: input.providerId,
      companyId: input.companyId,
      userId: input.userId,
      verifier,
      displayName: input.displayName ?? null,
    });
    return {
      providerId: input.providerId,
      authorizeUrl: buildAuthorizeUrl({ spec, client, state, codeVerifier: verifier }),
      state,
    };
  }

  /** The provider sent the owner back with a code: store the token and record the account. */
  async completeConnect(input: { state: string; code: string }): Promise<CloudAccount> {
    const oauth = this.oauth();
    const entry = oauth.stateStore.consume(input.state);
    if (!entry) throw new CloudConnectorError(400, "this connect link has expired; start again from the panel");
    const spec = (oauth.specs ?? CLOUD_OAUTH_SPECS)[entry.providerId];
    const client = oauth.clients[entry.providerId];
    if (!client) throw new CloudConnectorError(409, `${spec.displayName} is not configured on this instance`);
    let bundle;
    try {
      bundle = await exchangeCode({
        spec,
        client,
        code: input.code,
        codeVerifier: entry.verifier,
        fetchImpl: oauth.fetchImpl,
        now: oauth.now,
      });
    } catch (error) {
      throw new CloudConnectorError(400, `the cloud refused the authorization: ${(error as Error).message}`);
    }
    const value = serializeTokenBundle(bundle);
    const previous = (await this.document()).accounts.find(
      (account) => account.providerId === entry.providerId && account.companyId === entry.companyId,
    );
    const tokenRef = previous
      ? await this.reuseAccountSecret(oauth.tokenStore, previous, entry.companyId, value)
      : (
          await oauth.tokenStore.write({
            companyId: entry.companyId,
            ...accountSecretNaming(entry.providerId),
            value,
            actor: { userId: entry.userId },
          })
        ).secretId;
    return this.connectAccount(
      {
        providerId: entry.providerId,
        displayName: entry.displayName ?? spec.displayName,
        companyId: entry.companyId,
        tokenRef,
        scopes: bundle.scopes.length > 0 ? bundle.scopes : spec.scopes,
      },
      entry.userId,
    );
  }

  /** Reconnecting rewrites the same secret, so no orphan token is left behind. */
  private async reuseAccountSecret(store: CloudTokenStore, account: CloudAccount, companyId: string, value: string): Promise<string> {
    const current = await store.read(companyId, account.tokenRef);
    if (!current) {
      const written = await store.write({
        companyId,
        ...accountSecretNaming(account.providerId),
        value,
      });
      return written.secretId;
    }
    await store.rotate({ secretId: account.tokenRef, value, expectedLatestVersion: current.version });
    return account.tokenRef;
  }

  /** One account per provider and company: connecting again replaces the previous one. */
  async connectAccount(input: CreateAccountInput, actor: string): Promise<CloudAccount> {
    if (!this.deps.providers.has(input.providerId)) {
      throw new CloudConnectorError(400, `unknown cloud provider "${input.providerId}"`);
    }
    const account: CloudAccount = {
      id: this.newId(),
      providerId: input.providerId,
      displayName: input.displayName,
      companyId: input.companyId,
      tokenRef: input.tokenRef,
      scopes: input.scopes ?? [],
      connectedAt: this.iso(),
      connectedBy: actor,
    };
    await this.store().mutate( (current) => ({
      next: {
        ...current,
        accounts: [
          ...current.accounts.filter(
            (entry) => !(entry.providerId === input.providerId && entry.companyId === input.companyId),
          ),
          account,
        ],
      },
      result: account,
    }));
    return account;
  }

  async disconnectAccount(accountId: string): Promise<boolean> {
    const { result } = await this.store().mutate( (current) => {
      const accounts = current.accounts.filter((entry) => entry.id !== accountId);
      if (accounts.length === current.accounts.length) return { next: null, result: false };
      return { next: { ...current, accounts }, result: true };
    });
    return result;
  }

  // -- roots ----------------------------------------------------------------

  async listRoots(providerId?: CloudProviderId, companyId?: string): Promise<CloudRoot[]> {
    let roots = (await this.document()).roots;
    if (providerId) roots = roots.filter((root) => root.providerId === providerId);
    if (companyId) roots = roots.filter((root) => root.companyId === companyId);
    return roots;
  }

  async createRoot(input: CreateRootInput, _actor: string): Promise<CloudRoot> {
    if (!this.deps.providers.has(input.providerId)) {
      throw new CloudConnectorError(400, `unknown cloud provider "${input.providerId}"`);
    }
    const root: CloudRoot = {
      id: this.newId(),
      providerId: input.providerId,
      companyId: input.companyId,
      name: input.name,
      kind: input.kind,
      description: input.description ?? "",
      driveId: input.kind === "shared" ? (input.driveId ?? null) : null,
      itemId: input.kind === "shared" ? (input.itemId ?? null) : null,
      folder: input.kind === "own" ? (input.folder ?? null) : null,
      personalForAgentId: null,
      createdAt: this.iso(),
    };
    await this.store().mutate( (current) => {
      if (
        current.roots.some(
          (entry) =>
            entry.providerId === root.providerId && entry.companyId === root.companyId && entry.name === root.name,
        )
      ) {
        throw new CloudConnectorError(409, `a folder named "${root.name}" already exists for this provider`);
      }
      return { next: { ...current, roots: [...current.roots, root] }, result: root };
    });
    return root;
  }

  /** Removing a root removes the grants that point at it, but keeps the journal. */
  async removeRoot(rootId: string): Promise<boolean> {
    const { result } = await this.store().mutate( (current) => {
      const roots = current.roots.filter((entry) => entry.id !== rootId);
      if (roots.length === current.roots.length) return { next: null, result: false };
      return {
        next: { ...current, roots, grants: current.grants.filter((grant) => grant.rootId !== rootId) },
        result: true,
      };
    });
    return result;
  }

  // -- grants ---------------------------------------------------------------

  async listGrants(): Promise<CloudGrant[]> {
    return (await this.document()).grants;
  }

  async setGrant(input: SetGrantInput, actor: string): Promise<CloudGrant> {
    const document = await this.document();
    const root = document.roots.find((entry) => entry.id === input.rootId);
    if (!root) throw new CloudConnectorError(404, "unknown cloud folder");
    try {
      assertModeAllowedForRoot(root, input.mode);
    } catch (error) {
      throw new CloudConnectorError(400, (error as Error).message);
    }
    const grant: CloudGrant = {
      id: this.newId(),
      rootId: input.rootId,
      targetKind: input.targetKind,
      agentId: input.targetKind === "agent" ? (input.agentId ?? null) : null,
      caste: input.targetKind === "caste" ? (input.caste ?? null) : null,
      mode: input.mode,
      createdAt: this.iso(),
      createdBy: actor,
    };
    await this.store().mutate( (current) => {
      // One grant per (root, target): re-granting replaces the mode.
      const grants = current.grants.filter(
        (entry) =>
          !(
            entry.rootId === grant.rootId
            && entry.targetKind === grant.targetKind
            && entry.agentId === grant.agentId
            && entry.caste === grant.caste
          ),
      );
      return { next: { ...current, grants: [...grants, grant] }, result: grant };
    });
    return grant;
  }

  async removeGrant(grantId: string): Promise<boolean> {
    const { result } = await this.store().mutate( (current) => {
      const grants = current.grants.filter((entry) => entry.id !== grantId);
      if (grants.length === current.grants.length) return { next: null, result: false };
      return { next: { ...current, grants }, result: true };
    });
    return result;
  }

  // -- reading --------------------------------------------------------------

  async accessFor(identity: CloudAgentIdentity): Promise<CloudResolvedAccess[]> {
    const document = await this.document();
    return resolveAccess(document.roots, document.grants, identity);
  }

  async journal(limit = 100): Promise<CloudJournalEntry[]> {
    return (await this.document()).journal.slice(0, limit);
  }

  /** Board-side folder tree of one root (the owner configuring grants). */
  async tree(providerId: CloudProviderId, rootName: string, path: string, limit = 200, companyId?: string): Promise<CloudListing> {
    const document = await this.document();
    const root = document.roots.find(
      (entry) =>
        entry.providerId === providerId
        && entry.name === rootName
        && (companyId === undefined || entry.companyId === companyId),
    );
    if (!root) throw new CloudConnectorError(404, "unknown cloud folder");
    const provider = this.deps.providers.get(root.providerId);
    if (!provider) throw new CloudConnectorError(400, `unknown cloud provider "${root.providerId}"`);
    return provider.list({ root, parts: splitCloudPath(path) }, limit);
  }

  // -- agent tool calls -----------------------------------------------------

  async callTool(identity: CloudAgentIdentity, call: CloudToolCall): Promise<CloudToolResult> {
    const document = await this.document();
    const access = resolveNamedRoot(document.roots, document.grants, identity, call.root);
    const audit = async (ok: boolean, detail: string | null, root: CloudRoot | null): Promise<void> => {
      const entry: CloudJournalEntry = {
        id: this.newId(),
        at: this.iso(),
        actor: identity.agentId,
        tool: call.tool,
        rootId: root?.id ?? null,
        rootName: root?.name ?? call.root,
        path: call.path ?? null,
        ok,
        detail,
      };
      await this.store().mutate( (current) => ({
        next: appendJournal(current, entry),
        result: entry,
      }));
    };

    try {
      if (!access) throw new CloudConnectorError(403, outsideGrantMessage(call.root));
      const provider = this.deps.providers.get(access.root.providerId);
      if (!provider) throw new CloudConnectorError(400, `unknown cloud provider "${access.root.providerId}"`);
      const parts = splitCloudPath(call.path);
      const location = { root: access.root, parts };

      switch (call.tool) {
        case "cloud_list": {
          const listing = await provider.list(location, 200);
          await audit(true, `listed ${listing.items.length} entries`, access.root);
          return { ok: true, tool: call.tool, root: call.root, path: listing.path, result: listing };
        }
        case "cloud_search": {
          const hits = await provider.search(location, call.query ?? "", 20);
          await audit(true, `found ${hits.length} entries`, access.root);
          return { ok: true, tool: call.tool, root: call.root, path: call.path ?? "", result: hits };
        }
        case "cloud_read":
        case "cloud_download": {
          const limit = call.tool === "cloud_read" ? CLOUD_READ_LIMIT_BYTES : CLOUD_DOWNLOAD_LIMIT_BYTES;
          const { item, content } = await provider.readBytes(location, limit);
          await audit(true, `read ${item.name} (${content.byteLength} bytes)`, access.root);
          return {
            ok: true,
            tool: call.tool,
            root: call.root,
            path: call.path ?? "",
            result: { item, contentBase64: Buffer.from(content).toString("base64") },
          };
        }
        case "cloud_upload": {
          if (!allowsWrite(access.mode)) throw new CloudConnectorError(403, readOnlyMessage(access.root.name));
          if (!call.contentBase64) throw new CloudConnectorError(400, "upload needs file content");
          const content = Buffer.from(call.contentBase64, "base64");
          const item = await provider.upload(location, new Uint8Array(content), call.overwrite === true);
          await audit(true, `uploaded ${item.name} (${content.byteLength} bytes)`, access.root);
          return { ok: true, tool: call.tool, root: call.root, path: call.path ?? "", result: item };
        }
        case "cloud_move": {
          if (!allowsWrite(access.mode)) throw new CloudConnectorError(403, readOnlyMessage(access.root.name));
          const destination = resolveNamedRoot(document.roots, document.grants, identity, call.toRoot ?? "");
          if (!destination) throw new CloudConnectorError(403, outsideGrantMessage(call.toRoot ?? ""));
          if (!allowsWrite(destination.mode)) throw new CloudConnectorError(403, readOnlyMessage(destination.root.name));
          if (destination.root.providerId !== access.root.providerId) {
            throw new CloudConnectorError(400, "moving between cloud providers is not supported");
          }
          const item = await provider.move(location, { root: destination.root, parts: splitCloudPath(call.toPath) });
          await audit(true, `moved ${item.name}`, access.root);
          return { ok: true, tool: call.tool, root: call.root, path: call.path ?? "", result: item };
        }
        default:
          throw new CloudConnectorError(400, `unknown cloud tool "${call.tool}"`);
      }
    } catch (error) {
      const message = error instanceof CloudConnectorError ? error.message : "the cloud operation failed";
      const root = access?.root ?? null;
      await audit(false, message, root);
      return { ok: false, tool: call.tool, root: call.root, path: call.path ?? "", error: message };
    }
  }

  /**
   * Give an agent its own folder: created on first use, granted read-write to
   * that agent only. Returns the existing personal root when it is already set up.
   */
  async ensurePersonalRoot(providerId: CloudProviderId, companyId: string, agentId: string, actor: string): Promise<CloudRoot> {
    const rootName = personalRootName(agentId);
    const provider = this.deps.providers.get(providerId);
    if (!provider) throw new CloudConnectorError(400, `unknown cloud provider "${providerId}"`);
    const existing = (await this.document()).roots.find(
      (entry) => entry.providerId === providerId && entry.companyId === companyId && entry.name === rootName,
    );
    if (existing) return existing;
    const root: CloudRoot = {
      id: this.newId(),
      providerId,
      companyId,
      name: rootName,
      kind: "own",
      description: "Personal folder of one agent",
      driveId: null,
      itemId: null,
      folder: personalRootFolder(agentId),
      personalForAgentId: agentId,
      createdAt: this.iso(),
    };
    await provider.ensureFolder({ root, parts: [] });
    await this.setGrantForRoot(root, agentId, actor);
    return root;
  }

  private async setGrantForRoot(root: CloudRoot, agentId: string, actor: string): Promise<CloudGrant> {
    const grant: CloudGrant = {
      id: this.newId(),
      rootId: root.id,
      targetKind: "agent",
      agentId,
      caste: null,
      mode: "rw",
      createdAt: this.iso(),
      createdBy: actor,
    };
    await this.store().mutate( (current) => ({
      next: {
        ...current,
        roots: current.roots.some((entry) => entry.id === root.id)
          ? current.roots
          : [...current.roots, root],
        grants: [...current.grants.filter((entry) => !(entry.rootId === root.id && entry.agentId === agentId)), grant],
      },
      result: grant,
    }));
    return grant;
  }
}

export function cloudConnectorService(deps: CloudConnectorServiceDeps): CloudConnectorService {
  return new CloudConnectorService(deps);
}