import fs from "node:fs";
import {
  findPaperclipConfigKeyWarnings,
  paperclipConfigSchema,
  type PaperclipConfig,
} from "@paperclipai/shared";
import { ZodError } from "zod";
import { resolvePaperclipConfigPath } from "./paths.js";
// myrmidon(B1c): product name in user-facing texts; see product.ts.
import { PRODUCT_NAME as PN } from "./myrmidon/product.js";

function formatConfigValidationError(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const issuePath = issue.path.length > 0 ? issue.path.join(".") : "<root>";
      return `${issuePath}: ${issue.message}`;
    })
    .join("; ");
}

export function readConfigFile(): PaperclipConfig | null {
  const configPath = resolvePaperclipConfigPath();

  if (!fs.existsSync(configPath)) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${PN} config at ${configPath}: failed to read or parse JSON: ${reason}`);
  }

  try {
    const config = paperclipConfigSchema.parse(raw);
    for (const warning of findPaperclipConfigKeyWarnings(config)) {
      console.warn(
        `Unknown config key ${warning.path}; did you mean ${warning.suggestion}? It will be preserved.`,
      );
    }
    return config;
  } catch (error) {
    if (error instanceof ZodError) {
      throw new Error(`Invalid ${PN} config at ${configPath}: ${formatConfigValidationError(error)}`);
    }

    throw error;
  }
}
