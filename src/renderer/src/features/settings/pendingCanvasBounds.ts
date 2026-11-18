import type { AppSettings, BrowserCanvasState } from "../../../../shared/contracts";
import { reconcilePendingBounds, type PendingBounds } from "../workspace/pendingBounds.ts";

/**
 * Cards whose bounds live in settings (sticky notes, file cards, plugin canvas, the browser)
 * commit a move or a resize by writing settings, and every settings snapshot the main process
 * hands back is applied whole — a response to an earlier patch, a broadcast, a re-read. One of
 * those built before the person's own commit therefore rewrites `position`/`size` with the old
 * values and the card slides back under the pointer.
 *
 * The rule the session cards already follow applies to them too: the bounds the person just
 * committed are authoritative until main echoes exactly those bounds, with the same hard grace
 * window so a lost echo can never freeze a card.
 */
export interface PendingCanvasBounds {
  stickyNotes: Map<string, PendingBounds>;
  fileCards: Map<string, PendingBounds>;
  pluginCanvas: Map<string, PendingBounds>;
  browserCanvas: Map<string, PendingBounds>;
}

/** The browser card has no id of its own; its single bounds entry is keyed by this. */
export const BROWSER_BOUNDS_ID = "browser";

export function createPendingCanvasBounds(): PendingCanvasBounds {
  return {
    stickyNotes: new Map(),
    fileCards: new Map(),
    pluginCanvas: new Map(),
    browserCanvas: new Map()
  };
}

/**
 * Applies the commit-wins rule to a whole settings snapshot and returns the snapshot itself
 * when nothing had to change, so a re-render that carries no new bounds stays free.
 */
export function reconcileSettingsBounds(
  settings: AppSettings,
  pending: PendingCanvasBounds,
  now: number,
  graceMs?: number
): AppSettings {
  const stickyNotes = reconcilePendingBounds(settings.stickyNotes, pending.stickyNotes, now, graceMs);
  const fileCards = reconcilePendingBounds(settings.fileCards, pending.fileCards, now, graceMs);
  const pluginCanvas = reconcilePendingBounds(settings.pluginCanvas, pending.pluginCanvas, now, graceMs);
  const browser = settings.browserCanvas
    ? reconcilePendingBounds(
      [{ ...settings.browserCanvas, id: BROWSER_BOUNDS_ID }],
      pending.browserCanvas,
      now,
      graceMs
    )[0]
    : null;
  const browserCanvas: BrowserCanvasState | null = settings.browserCanvas && browser
    ? { ...settings.browserCanvas, position: browser.position, size: browser.size }
    : settings.browserCanvas;

  if (stickyNotes === settings.stickyNotes
    && fileCards === settings.fileCards
    && pluginCanvas === settings.pluginCanvas
    && browserCanvas === settings.browserCanvas) return settings;

  return { ...settings, stickyNotes, fileCards, pluginCanvas, browserCanvas };
}
