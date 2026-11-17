/**
 * On macOS `dialog.showOpenDialog(owner, …)` is presented as a sheet attached to that window. A
 * sheet attached to a window that is in a native fullscreen Space (or otherwise off the active
 * Space) stays invisible while the renderer waits for the promise to settle, which reads as a
 * frozen app: the launch dialog stops responding and no picker ever appears. Presenting the panel
 * without an owner (`app-modal`) avoids the whole class — macOS raises it as its own window on the
 * visible Space, in fullscreen and out of it.
 *
 * Kept free of `electron` imports so the decision is unit-testable outside the app runtime.
 */
export interface DialogOwnerState {
  isFullScreen: () => boolean;
  isSimpleFullScreen: () => boolean;
}

/** True when a sheet attached to this window would not be visible, so the panel must be app-modal. */
export function needsAppModalDialog(owner: DialogOwnerState | null | undefined): boolean {
  if (!owner) return true;
  try {
    return owner.isFullScreen() || owner.isSimpleFullScreen();
  } catch {
    // A destroyed window throws here; the person still needs a working picker.
    return true;
  }
}
