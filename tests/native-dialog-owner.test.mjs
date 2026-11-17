import assert from "node:assert/strict";
import test from "node:test";
import { needsAppModalDialog } from "../src/main/ipc/nativeDialog.ts";

const windowState = ({ fullScreen = false, simpleFullScreen = false } = {}) => ({
  isFullScreen: () => fullScreen,
  isSimpleFullScreen: () => simpleFullScreen
});

test("windowed window keeps the sheet attached to its own window", () => {
  assert.equal(needsAppModalDialog(windowState()), false);
});

test("native fullscreen window presents an app-modal panel", () => {
  // A sheet attached to a fullscreen window stays invisible while the renderer waits for the
  // promise, so the folder picker looks frozen. The app-modal panel is raised on the visible Space.
  assert.equal(needsAppModalDialog(windowState({ fullScreen: true })), true);
});

test("simple fullscreen (pre-Lion style) window also goes app-modal", () => {
  assert.equal(needsAppModalDialog(windowState({ simpleFullScreen: true })), true);
});

test("no owner window at all presents an app-modal panel", () => {
  assert.equal(needsAppModalDialog(null), true);
});

test("a destroyed window never blocks the picker", () => {
  const destroyed = {
    isFullScreen: () => {
      throw new Error("Object has been destroyed");
    },
    isSimpleFullScreen: () => {
      throw new Error("Object has been destroyed");
    }
  };
  assert.equal(needsAppModalDialog(destroyed), true);
});
