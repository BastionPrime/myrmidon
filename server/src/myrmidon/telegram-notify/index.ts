// myrmidon(1.6-TG-NOTIFY-C): the module barrel. Part C of the telegram
// notify umbrella: the board errors channel (severity filter + rate limit,
// delivery through the existing chat publication path). The shared JSON
// contract lives in packages/shared/src/myrmidon-telegram-notify.ts; part A
// owns the settings routes and changelog.
export * from "./errors.js";
export * from "./settings.js";
export * from "./sweep.js";
