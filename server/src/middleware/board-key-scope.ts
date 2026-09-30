// myrmidon(ROLE-SCOPED-TOKENS): enforce board API key scopes for admin actions.
// A board key with a stored scope may only perform the admin actions that its
// scope allows; requests outside the scope are rejected with 403 before the
// route runs. Keys without a stored scope (created before this change, or
// explicitly "full") keep unrestricted board access, so existing operator and
// CLI flows are unaffected.
import type { Request, Response, NextFunction } from "express";
import type { BoardApiKeyScope } from "@paperclipai/shared";
import { forbidden } from "../errors.js";

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Route prefixes whose mutations are permitted per scope kind. Prefixes are
// matched against the path below /api. A mutating route not listed here is
// denied for every non-full scope (default-deny).
const MUTATION_ALLOWLIST: Record<
  Exclude<BoardApiKeyScope["kind"], "full" | "read_only">,
  string[]
> = {
  ops: [
    "/health",
    "/chat-endpoints",
    "/chat-identity-links",
    "/tool-connections",
    "/tool-gateway",
    "/tool-profiles",
    "/tool-profile-entries",
    "/tool-applications",
    "/secret-provider-configs",
    "/plugins",
    "/_plugins",
  ],
  agents_manage: [
    "/agents",
    "/invites",
    "/join-requests",
    "/board",
    "/board-claim",
    "/chat-endpoints",
  ],
  secrets_manage: [
    "/secrets",
    "/secret-provider-configs",
    "/companies",
  ],
  release: [
    "/health",
    "/issues",
    "/work-products",
    "/attachments",
    "/execution-workspaces",
  ],
};

// Company-scoped mutation paths under /companies/:id/... that belong to a
// scope's domain (e.g. POST /companies/:id/secrets for secrets_manage).
const COMPANY_NESTED_MUTATIONS: Record<
  Exclude<BoardApiKeyScope["kind"], "full" | "read_only">,
  string[]
> = {
  ops: ["/tool-connections", "/tool-gateway", "/chat-endpoints"],
  agents_manage: ["/agents", "/invites", "/join-requests", "/chat-endpoints"],
  secrets_manage: ["/secrets", "/secret-provider-configs"],
  release: ["/issues", "/work-products", "/attachments"],
};

function matchPrefix(pathBelowApi: string, prefix: string) {
  if (prefix === "/companies") {
    // Bare /companies mutations (create/list companies) stay full-only.
    return false;
  }
  return (
    pathBelowApi === prefix ||
    pathBelowApi.startsWith(prefix + "/") ||
    pathBelowApi.startsWith(prefix + "?")
  );
}

function companyNestedMatch(pathBelowApi: string, nested: string) {
  const m = /^\/companies\/[^/]+(\/.*)$/.exec(pathBelowApi);
  if (!m) return false;
  const rest = m[1];
  return rest === nested || rest.startsWith(nested + "/");
}

export function boardApiKeyScopeAllows(
  scope: BoardApiKeyScope | null | undefined,
  method: string,
  pathBelowApi: string,
): boolean {
  if (!scope || scope.kind === "full") return true;
  if (READ_METHODS.has(method.toUpperCase())) return true;
  if (scope.kind === "read_only") return false;
  const prefixes = MUTATION_ALLOWLIST[scope.kind] ?? [];
  if (prefixes.some((p) => matchPrefix(pathBelowApi, p))) return true;
  const nested = COMPANY_NESTED_MUTATIONS[scope.kind] ?? [];
  if (nested.some((n) => companyNestedMatch(pathBelowApi, n))) return true;
  return false;
}

export function boardKeyScopeMiddleware() {
  return (req: Request, _res: Response, next: NextFunction) => {
    // myrmidon(ROLE-SCOPED-TOKENS): only board-key actors carry a key scope;
    // session/local/cloud board actors are operator context, not role keys.
    if (req.actor?.type !== "board" || req.actor?.source !== "board_key") {
      next();
      return;
    }
    const scope = req.actor.boardKeyScope;
    if (!scope || scope.kind === "full") {
      next();
      return;
    }
    const pathBelowApi = req.path.replace(/^\/api\/?/, "");
    if (boardApiKeyScopeAllows(scope, req.method, pathBelowApi)) {
      next();
      return;
    }
    next(
      forbidden(`Board API key scope '${scope.kind}' does not allow this action`, {
        scope: scope.kind,
        method: req.method,
        path: req.path,
      }),
    );
  };
}
