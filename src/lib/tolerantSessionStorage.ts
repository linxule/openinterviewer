// Storage for the persisted participant/preview store (src/store.ts) that
// never throws. Zustand's persist middleware updates memory first and then
// calls setItem without catching, so a throwing write (quota exceeded, storage
// disabled) would escape every store update, including the link page's
// beginParticipantSession (issue #52).
//
// A failed read is "nothing persisted". A failed write removes the entry, so
// the tab is left exactly as if storage were unavailable: the session goes on
// in memory only, and no older copy can be restored by a document load or
// mistaken for the current session by the link hand-over
// (src/lib/participantLinkHandover.ts). A later write that fits persists the
// whole state again; every write is a full snapshot.

type SessionStorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface TolerantStorage {
  getItem(name: string): string | null;
  setItem(name: string, value: string): void;
  removeItem(name: string): void;
}

export function tolerantStorage(
  resolve: () => SessionStorageLike = () => window.sessionStorage,
): TolerantStorage {
  const removeQuietly = (name: string) => {
    try {
      resolve().removeItem(name);
    } catch {
      // Storage is unavailable: there is nothing to remove.
    }
  };
  return {
    getItem(name) {
      try {
        return resolve().getItem(name);
      } catch {
        return null;
      }
    },
    setItem(name, value) {
      try {
        resolve().setItem(name, value);
      } catch {
        removeQuietly(name);
      }
    },
    removeItem: removeQuietly,
  };
}
