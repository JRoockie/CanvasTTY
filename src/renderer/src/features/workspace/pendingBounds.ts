/**
 * A card the person just moved must not be pulled back by the launch burst.
 *
 * While a session starts, the main process emits a stream of session snapshots (create, spawn,
 * awaiting resize, attach, state changes). Some of them were built before the drag was committed,
 * so applying them wholesale — which is what `upsertSession` does — rewrites `position`/`size` with
 * the old values and the card visibly jumps back for as long as the burst lasts.
 *
 * The renderer therefore keeps the bounds it just sent as authoritative until the main process
 * echoes exactly those bounds, with a hard grace window so a lost echo can never freeze a card.
 *
 * Pure on purpose: no Electron, no React, so the rule is unit-testable.
 */
export interface BoundsLike {
  position: { x: number; y: number };
  size: { width: number; height: number };
}

export interface SessionLike extends BoundsLike {
  id: string;
}

export interface PendingBounds {
  bounds: BoundsLike;
  at: number;
}

/** How long a committed position outranks incoming snapshots. */
export const PENDING_BOUNDS_GRACE_MS = 3_000;

export function rememberPendingBounds(
  pending: Map<string, PendingBounds>,
  id: string,
  bounds: BoundsLike,
  now: number
): void {
  pending.set(id, { bounds: { position: { ...bounds.position }, size: { ...bounds.size } }, at: now });
}

function sameBounds(left: BoundsLike, right: BoundsLike): boolean {
  return left.position.x === right.position.x
    && left.position.y === right.position.y
    && left.size.width === right.size.width
    && left.size.height === right.size.height;
}

/**
 * Keeps committed bounds for sessions whose echo has not arrived yet, drops settled and expired
 * entries, and returns the incoming array untouched when nothing had to change.
 */
export function reconcilePendingBounds<T extends SessionLike>(
  sessions: T[],
  pending: Map<string, PendingBounds>,
  now: number,
  graceMs: number = PENDING_BOUNDS_GRACE_MS
): T[] {
  if (pending.size === 0) return sessions;

  let changed = false;
  const next = sessions.map((session) => {
    const entry = pending.get(session.id);
    if (!entry) return session;
    if (sameBounds(session, entry.bounds)) {
      pending.delete(session.id);
      return session;
    }
    if (now - entry.at > graceMs) {
      pending.delete(session.id);
      return session;
    }
    changed = true;
    return { ...session, position: { ...entry.bounds.position }, size: { ...entry.bounds.size } } as T;
  });

  // Drop entries for cards that disappeared while the guard was up.
  for (const id of [...pending.keys()]) {
    if (!sessions.some((session) => session.id === id)) pending.delete(id);
  }

  return changed ? next : sessions;
}
