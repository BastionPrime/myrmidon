// server/src/myrmidon/agent-memory/settings.ts
//
// myrmidon(MEMORY-UI): settings for the agent memory card section.
//
// The board server talks to the shared hindsight service directly (the same
// service the memory plugin and bot containers use). Like the LLM gateway
// collection (M2-A) the address and key are instance settings, not code:
// without both the memory card answers "not enabled" instead of guessing.

export const MEMORY_HINDSIGHT_API_URL_ENV = "MYRMIDON_HINDSIGHT_API_URL";
export const MEMORY_HINDSIGHT_KEY_SECRET_ENV = "MYRMIDON_HINDSIGHT_KEY_SECRET";

export interface MemoryUiSettings {
  enabled: boolean;
  baseUrl: string | null;
  /** Name of the company secret holding the hindsight API key. */
  keySecret: string | null;
}

/** Trimmed non-empty value, or null. */
function readNonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * An http(s) URL, or null when unset/invalid. An invalid non-empty value is
 * reported as null (the section then says "not enabled"), never as a crash:
 * the memory card is a read surface, and a bad setting must not take the
 * agent page down. The operator sees the reason in the section's status line.
 */
export function readHttpUrlSetting(value: string | undefined): string | null {
  const trimmed = readNonEmpty(value);
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  } catch {
    return null;
  }
  return trimmed;
}

export function readMemoryUiSettings(env: NodeJS.ProcessEnv = process.env): MemoryUiSettings {
  const baseUrl = readHttpUrlSetting(env[MEMORY_HINDSIGHT_API_URL_ENV]);
  const keySecret = readNonEmpty(env[MEMORY_HINDSIGHT_KEY_SECRET_ENV]);
  return { enabled: Boolean(baseUrl && keySecret), baseUrl, keySecret };
}
