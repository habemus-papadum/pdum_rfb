// Typed same-origin REST client for the `pdum-rfb demo` control plane (served by the
// Python ASGI app). Everything is relative to the page origin, so no host/port config.

export interface SceneCap {
  key: string;
  name: string;
  description: string;
  tags: string[];
  available: boolean;
  reason: string;
}

export interface BackendCap {
  id: string;
  label: string;
  available: boolean;
  reason: string;
}

export interface Control {
  id: string;
  label: string;
  type: string;
  scope: "stream" | "create" | "viewer";
  choices?: string[];
  min?: number;
  max?: number;
  default?: unknown;
  help: string;
}

export interface Capabilities {
  scenes: SceneCap[];
  backends: BackendCap[];
  controls: Control[];
  platform: { system: string; machine: string; is_mac_arm: boolean; python: string };
  limits: { private_stream_cap: number };
}

export interface StreamState {
  name: string;
  ws: string;
  private: boolean;
  clients: number;
  scene: string;
  backend: string;
  bitrate: number;
  bitrate_label: string;
  fps: number;
  width: number;
  height: number;
  color: string;
  adaptive: boolean;
  still_after: number | null;
  stats_interval: number | null;
  encode_pipeline_depth: number;
  resize_policy: string;
  max_render_dimension: number | null;
  last_error: string | null;
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data.error ?? `${res.status} ${res.statusText}`);
  return data as T;
}

export const api = {
  capabilities: () => req<Capabilities>("GET", "/demo/capabilities"),
  state: () => req<{ streams: StreamState[] }>("GET", "/demo/state"),
  createStream: (body: Record<string, unknown>) => req<StreamState>("POST", "/demo/streams", body),
  deleteStream: (name: string) => req<{ ok: boolean }>("DELETE", `/demo/streams/${name}`),
  setScene: (name: string, key: string) => req<StreamState>("POST", `/demo/streams/${name}/scene`, { key }),
  setBackend: (name: string, id: string) => req<StreamState>("POST", `/demo/streams/${name}/backend`, { id }),
  setQuality: (name: string, q: { bitrate?: string; fps?: number }) =>
    req<StreamState>("POST", `/demo/streams/${name}/quality`, q),
  setParams: (name: string, p: Record<string, unknown>) =>
    req<StreamState>("POST", `/demo/streams/${name}/params`, p),
};

/** Same-origin framebuffer WebSocket URL for a stream (ws/wss mirrors the page). */
export function wsUrl(stream: string): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/rfb/${stream}`;
}
