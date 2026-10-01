// myrmidon(CLOUD-CONNECTOR): server-side types for the cloud storage connector.
//
// The wire contract lives in @paperclipai/shared/myrmidon-cloud-connector;
// this file adds the error type and the provider-facing shapes.

export type CloudConnectorStatus = 400 | 403 | 404 | 409 | 423 | 502;

/**
 * A refusal the agent or the board can act on. `message` is written for the
 * caller: for an agent it says which boundary was hit, never why the token
 * store is unhappy.
 */
export class CloudConnectorError extends Error {
  constructor(
    readonly status: CloudConnectorStatus,
    message: string,
  ) {
    super(message);
    this.name = "CloudConnectorError";
  }
}

/** One entry a provider returns for a folder listing or a search hit. */
export interface CloudItem {
  name: string;
  type: "file" | "folder";
  size: number | null;
  modified: string | null;
  /** Present for folders when the provider reports it. */
  children: number | null;
}

/** A folder listing as the provider sees it. */
export interface CloudListing {
  path: string;
  items: CloudItem[];
  truncated: boolean;
}

/** Identity of the agent on whose behalf a tool call runs. */
export interface CloudAgentIdentity {
  agentId: string;
  /** Free-form caste label the board already uses for tool visibility; null when unset. */
  caste: string | null;
}