import { expect, it } from "vitest";

import { botBoardGatewayUrl } from "./board-gateway.js";

// The gateway lives at the board's origin, with no /api: any other form fails
// with "Agent token did not verify". Placeholder ids only.
it("builds the gateway address without the api path", () => {
  expect(botBoardGatewayUrl("http://h/api/", "gw_00000000000000000000000000000000")).toBe(
    "http://h/mcp/gateways/gw_00000000000000000000000000000000",
  );
});
