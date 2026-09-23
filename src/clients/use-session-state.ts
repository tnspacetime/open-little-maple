import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import type {
  SessionClientStore,
  SessionSynchronization,
} from "./session-client-store.ts";

const noSession: SessionSynchronization | undefined = undefined;
const SessionStateContext = createContext<SessionClientStore | undefined>(
  undefined,
);

export function SessionStateProvider({
  store,
  children,
}: {
  store: SessionClientStore;
  children: ReactNode;
}) {
  return createElement(SessionStateContext.Provider, { value: store }, children);
}

export function useSessionClientStore(): SessionClientStore {
  const store = useContext(SessionStateContext);
  if (!store) {
    throw new Error("Session state components require SessionStateProvider");
  }
  return store;
}

export function useSessionState(
  sessionID: string | undefined,
): SessionSynchronization | undefined {
  const store = useSessionClientStore();
  const subscribe = useCallback(
    (listener: () => void) =>
      sessionID ? store.subscribe(sessionID, listener) : () => undefined,
    [store, sessionID],
  );
  const snapshot = useCallback(
    () => (sessionID ? store.state(sessionID) : noSession),
    [store, sessionID],
  );
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
