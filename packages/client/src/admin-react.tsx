import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { ReactorQueueAdminClient } from "./admin-client";
import {
  INITIAL_ADMIN_STATE,
  type AdminState,
  type ReactorQueueAdminClientOptions,
} from "./admin-types";

export interface AdminActions {
  connect: () => void;
  disconnect: () => void;
  refresh: () => void;
  kickMember: (connId: string) => void;
  kickQueued: (connId: string) => void;
  closeSession: (sessionId: string) => void;
}

interface AdminContextValue {
  client: ReactorQueueAdminClient;
  store: StoreApi<AdminState>;
  actions: AdminActions;
}

const AdminContext = createContext<AdminContextValue | null>(null);

export interface ReactorQueueAdminProviderProps extends ReactorQueueAdminClientOptions {
  children?: ReactNode;
}

/**
 * Authenticates to the PartyKit room in admin mode and mirrors
 * {@link AdminSnapshotMessage} payloads into a zustand store. Build your own
 * dashboard UI with {@link useReactorQueueAdmin} or {@link useAdminSelector}.
 */
export function ReactorQueueAdminProvider({
  children,
  ...options
}: ReactorQueueAdminProviderProps) {
  const clientRef = useRef<ReactorQueueAdminClient | null>(null);
  const storeRef = useRef<StoreApi<AdminState> | null>(null);

  if (!clientRef.current) {
    clientRef.current = new ReactorQueueAdminClient({ ...options, autoConnect: false });
  }
  if (!storeRef.current) {
    storeRef.current = createStore<AdminState>(() => ({ ...INITIAL_ADMIN_STATE }));
  }

  const client = clientRef.current;
  const store = storeRef.current;

  const actions = useMemo<AdminActions>(
    () => ({
      connect: () => client.connect(),
      disconnect: () => client.disconnect(),
      refresh: () => client.refresh(),
      kickMember: (connId: string) => client.kickMember(connId),
      kickQueued: (connId: string) => client.kickQueued(connId),
      closeSession: (sessionId: string) => client.closeSession(sessionId),
    }),
    [client]
  );

  const autoConnect = options.autoConnect ?? true;

  useEffect(() => {
    const unsubscribe = client.subscribe((state) => store.setState(state, true));
    if (autoConnect) client.connect();
    return () => {
      unsubscribe();
      client.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = useMemo<AdminContextValue>(
    () => ({ client, store, actions }),
    [client, store, actions]
  );

  return createElement(AdminContext.Provider, { value }, children);
}

function useAdminContext(): AdminContextValue {
  const ctx = useContext(AdminContext);
  if (!ctx) {
    throw new Error("useReactorQueueAdmin must be used inside a <ReactorQueueAdminProvider>");
  }
  return ctx;
}

/** Full admin state plus stable actions. */
export function useReactorQueueAdmin(): AdminState & AdminActions {
  const { store, actions } = useAdminContext();
  const state = useStore(store);
  return { ...state, ...actions };
}

/** Subscribe to a slice of admin state. */
export function useAdminSelector<T>(selector: (state: AdminState) => T): T {
  const { store } = useAdminContext();
  return useStore(store, selector);
}

export function useAdminActions(): AdminActions {
  return useAdminContext().actions;
}

export function useReactorQueueAdminClient(): ReactorQueueAdminClient {
  return useAdminContext().client;
}

export type {
  AdminPhase,
  AdminState,
  AdminPasswordSource,
  ReactorQueueAdminClientOptions,
} from "./admin-types";
export type {
  AdminLogEntry,
  AdminLogLevel,
  AdminSnapshotMessage,
} from "@reactor-team/queue-protocol";
export { ReactorQueueAdminClient } from "./admin-client";
