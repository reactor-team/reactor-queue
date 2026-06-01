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
import { ReactorQueueClient } from "./client";
import { INITIAL_STATE, type QueueState, type ReactorQueueClientOptions } from "./types";

/** Stable action surface exposed alongside queue state. */
export interface QueueActions {
  connect: () => void;
  leave: () => void;
  rejoin: () => void;
  claim: () => void;
  endSession: () => void;
  /** Resolver to pass straight into the Reactor SDK's `getJwt` prop. */
  getJwt: () => Promise<string>;
}

interface QueueContextValue {
  client: ReactorQueueClient;
  store: StoreApi<QueueState>;
  actions: QueueActions;
}

const QueueContext = createContext<QueueContextValue | null>(null);

export interface ReactorQueueProviderProps extends ReactorQueueClientOptions {
  children?: ReactNode;
}

/**
 * Owns a single {@link ReactorQueueClient} for its subtree and mirrors its
 * state into a zustand store. Connects on mount (unless `autoConnect={false}`)
 * and tears down on unmount.
 *
 * ```tsx
 * <ReactorQueueProvider host={process.env.NEXT_PUBLIC_PARTYKIT_HOST!}>
 *   <App />
 * </ReactorQueueProvider>
 * ```
 */
export function ReactorQueueProvider({ children, ...options }: ReactorQueueProviderProps) {
  // Create the client + store exactly once. Option changes after mount are
  // ignored by design (a queue connection should not churn on re-render).
  const clientRef = useRef<ReactorQueueClient | null>(null);
  const storeRef = useRef<StoreApi<QueueState> | null>(null);

  if (!clientRef.current) {
    clientRef.current = new ReactorQueueClient({ ...options, autoConnect: false });
  }
  if (!storeRef.current) {
    storeRef.current = createStore<QueueState>(() => ({ ...INITIAL_STATE }));
  }

  const client = clientRef.current;
  const store = storeRef.current;

  const actions = useMemo<QueueActions>(
    () => ({
      connect: () => client.connect(),
      leave: () => client.leave(),
      rejoin: () => client.rejoin(),
      claim: () => client.claim(),
      endSession: () => client.endSession(),
      getJwt: client.getJwt,
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
    // The client/store are stable for the provider's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = useMemo<QueueContextValue>(
    () => ({ client, store, actions }),
    [client, store, actions]
  );

  return createElement(QueueContext.Provider, { value }, children);
}

function useQueueContext(): QueueContextValue {
  const ctx = useContext(QueueContext);
  if (!ctx) {
    throw new Error("useReactorQueue must be used inside a <ReactorQueueProvider>");
  }
  return ctx;
}

/** Full queue state plus the stable action surface. */
export function useReactorQueue(): QueueState & QueueActions {
  const { store, actions } = useQueueContext();
  const state = useStore(store);
  return { ...state, ...actions };
}

/**
 * Subscribe to a slice of queue state to minimize re-renders.
 *
 * ```ts
 * const position = useQueueSelector((s) => s.position);
 * ```
 */
export function useQueueSelector<T>(selector: (state: QueueState) => T): T {
  const { store } = useQueueContext();
  return useStore(store, selector);
}

/** Stable actions without subscribing to state (won't re-render on state change). */
export function useQueueActions(): QueueActions {
  return useQueueContext().actions;
}

/** Escape hatch: the underlying client instance. */
export function useReactorQueueClient(): ReactorQueueClient {
  return useQueueContext().client;
}

export type { QueueState, QueuePhase, ReactorQueueClientOptions } from "./types";
export { ReactorQueueClient } from "./client";
