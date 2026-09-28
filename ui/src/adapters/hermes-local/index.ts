import type { UIAdapterModule } from "../types";
import {
  parseHermesStdoutLine,
  createHermesStdoutParser,
  buildHermesConfig,
} from "@paperclipai/hermes-paperclip-adapter/ui";
import { SchemaConfigFields } from "../schema-config-fields";

export const hermesLocalUIAdapter: UIAdapterModule = {
  type: "hermes_local",
  label: "Hermes",
  parseStdoutLine: parseHermesStdoutLine,
  // myrmidon(G5): carries the "still inside the Query: echo" flag across
  // lines so a live transcript doesn't show the wrapped prompt echo as fake
  // assistant chatter — see createHermesStdoutParser's doc comment.
  createStdoutParser: createHermesStdoutParser,
  ConfigFields: SchemaConfigFields,
  buildAdapterConfig: buildHermesConfig,
};
