// myrmidon(CLOUD-CONNECTOR): the agent-facing MCP surface.
//
// The board serves this JSON-RPC endpoint the way it serves project tools: the
// caller is the agent itself (its run key), never a proxy, and every call goes
// through the connector service, so the folder grants, the path confinement and
// the journal apply exactly as they do on POST /call. Nothing here re-implements
// access: it lists the six cloud tools and hands the call to the service.
//
// A refusal comes back as an MCP tool error whose text names the boundary the
// agent hit ("no access to folder …", "the folder … is read-only"), so an agent
// can tell the difference between "you were not granted this" and "this cloud
// said no".

import { Router, type Request } from "express";
import {
  CLOUD_TOOL_NAMES,
  cloudToolCallSchema,
  type CloudToolName,
} from "@paperclipai/shared/myrmidon-cloud-connector";
import { unauthorized } from "../../errors.js";
import { CLOUD_DOWNLOAD_LIMIT_BYTES, CLOUD_READ_LIMIT_BYTES, type CloudConnectorService } from "./service.js";
import type { CloudAgentIdentity } from "./types.js";

const PROTOCOL_VERSION = "2025-03-26";

interface CloudMcpTool {
  name: CloudToolName;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required: string[];
    additionalProperties: false;
  };
}

/**
 * The tool set an agent sees, with the two things it needs to act correctly:
 * which folder it may touch (only the ones granted to it) and what the argument
 * names are. `required` is enforced below, so a missing argument is answered
 * with the argument's name rather than a generic failure.
 */
export const CLOUD_MCP_TOOLS: CloudMcpTool[] = [
  {
    name: "cloud_list",
    description:
      "List one folder of a cloud folder granted to you. The path is relative to the granted root (empty means the root itself); entries outside the granted folder are never shown.",
    inputSchema: {
      type: "object",
      properties: {
        root: { type: "string", description: "Name of the granted cloud folder, as the owner named it." },
        path: { type: "string", description: "Folder path inside that root; omit or leave empty for the root." },
      },
      required: ["root"],
      additionalProperties: false,
    },
  },
  {
    name: "cloud_search",
    description:
      "Search inside a cloud folder granted to you. Only hits that are provably inside the granted root are returned (up to 20).",
    inputSchema: {
      type: "object",
      properties: {
        root: { type: "string", description: "Name of the granted cloud folder." },
        query: { type: "string", description: "Text to look for in entry names (1-200 characters)." },
      },
      required: ["root", "query"],
      additionalProperties: false,
    },
  },
  {
    name: "cloud_read",
    description: `Read a small file from a cloud folder granted to you, returned as base64 (up to ${CLOUD_READ_LIMIT_BYTES} bytes). Use cloud_download for anything larger.`,
    inputSchema: {
      type: "object",
      properties: {
        root: { type: "string", description: "Name of the granted cloud folder." },
        path: { type: "string", description: "File path inside that root." },
      },
      required: ["root", "path"],
      additionalProperties: false,
    },
  },
  {
    name: "cloud_download",
    description: `Download a file from a cloud folder granted to you, returned as base64 (up to ${CLOUD_DOWNLOAD_LIMIT_BYTES} bytes).`,
    inputSchema: {
      type: "object",
      properties: {
        root: { type: "string", description: "Name of the granted cloud folder." },
        path: { type: "string", description: "File path inside that root." },
      },
      required: ["root", "path"],
      additionalProperties: false,
    },
  },
  {
    name: "cloud_upload",
    description:
      "Write a file (base64 content) into a cloud folder granted to you with read-write. A read-only grant is refused; set overwrite to replace an existing file.",
    inputSchema: {
      type: "object",
      properties: {
        root: { type: "string", description: "Name of the granted cloud folder." },
        path: { type: "string", description: "File path inside that root." },
        contentBase64: { type: "string", description: "File content, base64 encoded." },
        overwrite: { type: "boolean", description: "Replace the file when it already exists." },
      },
      required: ["root", "path", "contentBase64"],
      additionalProperties: false,
    },
  },
  {
    name: "cloud_move",
    description:
      "Move or rename an entry between cloud folders granted to you with read-write. Both the source and the destination must be writable grants of the same cloud.",
    inputSchema: {
      type: "object",
      properties: {
        root: { type: "string", description: "Name of the granted cloud folder that holds the entry." },
        path: { type: "string", description: "Current path inside that root." },
        toRoot: { type: "string", description: "Granted cloud folder to move the entry into." },
        toPath: { type: "string", description: "New path inside that folder." },
      },
      required: ["root", "path", "toRoot", "toPath"],
      additionalProperties: false,
    },
  },
];

const REQUIRED_ARGUMENTS: Record<CloudToolName, string[]> = {
  cloud_list: ["root"],
  cloud_search: ["root", "query"],
  cloud_read: ["root", "path"],
  cloud_download: ["root", "path"],
  cloud_upload: ["root", "path", "contentBase64"],
  cloud_move: ["root", "path", "toRoot", "toPath"],
};

/** Agent identity for a tool call: the caller is the agent, never a proxy. */
function agentIdentity(req: Request): CloudAgentIdentity {
  const actor = req.actor;
  if (!actor || actor.type !== "agent" || !actor.agentId) throw unauthorized("Agent access required");
  return { agentId: actor.agentId, caste: null };
}

export function cloudConnectorMcpRoutes(deps: { service: CloudConnectorService }) {
  const router = Router();
  const { service } = deps;

  router.post("/mcp/cloud-tools", async (req, res) => {
    const body = (req.body ?? {}) as { id?: unknown; method?: unknown; params?: unknown };
    const id = body.id ?? null;
    const method = typeof body.method === "string" ? body.method : "";
    const send = (result: unknown) => res.json({ jsonrpc: "2.0", id, result });

    // Every method on this endpoint belongs to an agent: a board user or
    // nobody reaching here is not an agent call, and an unauthenticated caller
    // gets no answer at all — not even the server's handshake.
    const identity = agentIdentity(req);

    if (method === "initialize") {
      return send({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "myrmidon-cloud-connector", version: "1" },
      });
    }
    if (method === "notifications/initialized") return res.status(202).end();

    if (method === "tools/list") return send({ tools: CLOUD_MCP_TOOLS });
    if (method !== "tools/call") {
      return res.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
    }

    const params = (body.params ?? {}) as { name?: unknown; arguments?: unknown };
    const name = typeof params.name === "string" ? params.name : "";
    if (!(CLOUD_TOOL_NAMES as readonly string[]).includes(name)) {
      return send({ content: [{ type: "text", text: `unknown cloud tool "${name}"` }], isError: true });
    }
    const tool = name as CloudToolName;
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const missing = REQUIRED_ARGUMENTS[tool].filter((key) => {
      const value = args[key];
      return value === undefined || value === null || (typeof value === "string" && value.trim().length === 0);
    });
    if (missing.length > 0) {
      return send({ content: [{ type: "text", text: `${tool} needs ${missing.join(", ")}` }], isError: true });
    }
    const parsed = cloudToolCallSchema.safeParse({ ...args, tool });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue?.path.join(".") || "arguments";
      return send({
        content: [{ type: "text", text: `${tool}: ${where} — ${issue?.message ?? "not valid"}` }],
        isError: true,
      });
    }

    const result = await service.callTool(identity, parsed.data);
    if (!result.ok) {
      return send({
        content: [{ type: "text", text: result.error ?? `${tool} was refused` }],
        isError: true,
        structuredContent: result,
      });
    }
    return send({
      content: [{ type: "text", text: JSON.stringify(result.result ?? null) }],
      structuredContent: result,
    });
  });

  return router;
}