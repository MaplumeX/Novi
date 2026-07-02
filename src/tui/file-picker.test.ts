import { describe, expect, it } from "vitest";
import { filePickerKeyAction } from "./file-picker.js";

/** Minimal Ink-style key payload for the cases under test. */
function key(
  partial: Partial<{
    upArrow: boolean;
    downArrow: boolean;
    return: boolean;
    tab: boolean;
    escape: boolean;
    backspace: boolean;
    delete: boolean;
    ctrl: boolean;
    meta: boolean;
  }>,
): Parameters<typeof filePickerKeyAction>[1] {
  return partial;
}

describe("filePickerKeyAction", () => {
  it("maps ↑ to up", () => {
    expect(filePickerKeyAction("", key({ upArrow: true }))).toBe("up");
  });

  it("maps ↓ to down", () => {
    expect(filePickerKeyAction("", key({ downArrow: true }))).toBe("down");
  });

  it("maps Enter to select", () => {
    expect(filePickerKeyAction("\r", key({ return: true }))).toBe("select");
  });

  it("maps Tab to select (Tab accepts the highlighted item)", () => {
    expect(filePickerKeyAction("\t", key({ tab: true }))).toBe("select");
  });

  it("maps Esc to cancel", () => {
    expect(filePickerKeyAction("", key({ escape: true }))).toBe("cancel");
  });

  it("maps Backspace to backspace", () => {
    expect(filePickerKeyAction("", key({ backspace: true }))).toBe("backspace");
  });

  it("maps Delete to backspace", () => {
    expect(filePickerKeyAction("", key({ delete: true }))).toBe("backspace");
  });

  it("maps printable chars to append", () => {
    expect(filePickerKeyAction("s", key({}))).toBe("append");
  });

  it("returns null for ctrl combinations", () => {
    expect(filePickerKeyAction("c", key({ ctrl: true }))).toBeNull();
  });

  it("returns null for meta combinations", () => {
    expect(filePickerKeyAction("b", key({ meta: true }))).toBeNull();
  });

  it("returns null for an empty value with no key flag", () => {
    expect(filePickerKeyAction("", key({}))).toBeNull();
  });

  it("Tab and Return yield the same action", () => {
    expect(filePickerKeyAction("\t", key({ tab: true }))).toBe(
      filePickerKeyAction("\r", key({ return: true })),
    );
  });
});
