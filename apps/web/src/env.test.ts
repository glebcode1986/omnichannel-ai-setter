import { EnvValidationError } from "@omnichannel/env";
import { describe, expect, it } from "vitest";

import { loadWebEnv } from "./env";

describe("loadWebEnv", () => {
  it("applies defaults", () => {
    expect(loadWebEnv({})).toEqual({ NODE_ENV: "development", LOG_LEVEL: "info" });
  });

  it("rejects invalid values", () => {
    expect(() => loadWebEnv({ LOG_LEVEL: "loud" })).toThrow(EnvValidationError);
  });
});
