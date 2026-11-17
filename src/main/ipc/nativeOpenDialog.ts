import { app, dialog } from "electron";
import type { BrowserWindow, OpenDialogOptions, OpenDialogReturnValue } from "electron";
import { needsAppModalDialog } from "./nativeDialog";

/** Panels currently open, per window. */
const openPanels = new Map<number, Promise<OpenDialogReturnValue>>();

/**
 * Every native open panel goes through here.
 *
 * Three things are added to a plain `dialog.showOpenDialog`:
 *  - the app is brought forward first, so a panel summoned while another app owns the frontmost
 *    Space is not born behind it;
 *  - when the owner window is fullscreen (or gone), the panel is presented app-modal instead of as
 *    a sheet attached to that window — see `nativeDialog.ts` for why the sheet never shows there;
 *  - a second request for the same window joins the panel that is already open. Stacking a modal
 *    behind an open modal session shows nothing and leaves the renderer waiting, which is the same
 *    "frozen" symptom one click later.
 */
export async function showOpenDialogForPerson(
  owner: BrowserWindow | null | undefined,
  options: OpenDialogOptions
): Promise<OpenDialogReturnValue> {
  const key = owner && !owner.isDestroyed() ? owner.webContents.id : undefined;
  const inFlight = key === undefined ? undefined : openPanels.get(key);
  if (inFlight) return inFlight;

  const task = (async () => {
    if (process.platform === "darwin") app.focus({ steal: true });
    return needsAppModalDialog(owner)
      ? dialog.showOpenDialog(options)
      : dialog.showOpenDialog(owner as BrowserWindow, options);
  })();

  if (key !== undefined) {
    openPanels.set(key, task);
    void task
      .catch(() => undefined)
      .finally(() => {
        if (openPanels.get(key) === task) openPanels.delete(key);
      });
  }
  return task;
}
