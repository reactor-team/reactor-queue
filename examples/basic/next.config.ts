import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@reactor-team/queue"],

  // The Reactor SDK's <ReactorProvider autoConnect> starts connect() on mount
  // and disconnect() on cleanup. React StrictMode double-invokes effects in dev
  // (mount → cleanup → remount), racing a connect() against a disconnect() and
  // crashing inside the SDK ("…reading 'pollSessionReady'"). Production never
  // double-mounts. Disable StrictMode here for a clean one-click dev flow; the
  // alternative is to drop autoConnect and connect via a button.
  reactStrictMode: false,
};

export default nextConfig;
