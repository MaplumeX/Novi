import { describe, expect, it } from "vitest";
import { decodePermissionError, encodePermissionError, findPermissionError } from "./errors.js";

describe("permission error codec", () => {
  it("round-trips a bounded stable code", () => {
    const encoded = encodePermissionError("PERMISSION_DENIED", "line one\nline two");
    expect(decodePermissionError(encoded)).toEqual({
      code: "PERMISSION_DENIED",
      message: "line one line two",
    });
  });

  it("decodes a denial after JSON persistence", () => {
    const persisted = JSON.parse(
      JSON.stringify({
        content: [
          {
            type: "text",
            text: encodePermissionError("PERMISSION_INTERACTION_REQUIRED", "approval required"),
          },
        ],
      }),
    );
    expect(findPermissionError(persisted)).toEqual({
      code: "PERMISSION_INTERACTION_REQUIRED",
      message: "approval required",
    });
  });
});
