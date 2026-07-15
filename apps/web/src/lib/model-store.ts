import {
  ModelProfileSchema,
  modelSupportsRole,
  type ModelProfile,
  type ModelSecret
} from "@drawguessai/ai-adapters";
import { openDB } from "idb";

export interface StoredModelProfile {
  profile: ModelProfile;
  apiKey?: string;
  remember: boolean;
}

const SESSION_KEY = "drawguessai:model-profiles";
const DB_NAME = "drawguessai-local-secrets";
const STORE_NAME = "model-profiles";
export const CCSWITCH_PROFILE_ID = "ccswitch-local-minimax-m3";
export const DEEPSEEK_DIRECT_PROFILE_ID = "deepseek-local-direct";

const BUILT_IN_LOCAL_PROFILE_IDS: ReadonlySet<string> = new Set([
  CCSWITCH_PROFILE_ID,
  DEEPSEEK_DIRECT_PROFILE_ID
]);

export function isBuiltInLocalProfileId(profileId: string | undefined): boolean {
  return profileId !== undefined && BUILT_IN_LOCAL_PROFILE_IDS.has(profileId);
}

function viteSetting(name: string): string | undefined {
  const environment = import.meta.env as unknown as Readonly<Record<string, unknown>>;
  const value = environment[name];
  return typeof value === "string" ? value.trim() : undefined;
}

export const DEMO_PROFILE: ModelProfile = ModelProfileSchema.parse({
  id: "demo",
  label: "Programmatic Demo Sketcher",
  protocol: "demo",
  execution: "local",
  baseUrl: "https://demo.invalid",
  model: "built-in-demo",
  capabilities: {
    vision: true,
    structuredOutput: "json-schema",
    observationMode: "one-shot",
    maxObservationPasses: 0,
    drawingPlanMode: "inline"
  },
  enabled: true
});

function ccswitchRecord(): StoredModelProfile | undefined {
  if (!import.meta.env.DEV) return undefined;
  const baseUrl = new URL("/ccswitch", window.location.href).href.replace(/\/$/, "");
  const vision = viteSetting("VITE_CCSWITCH_VISION")?.toLowerCase() !== "false";
  const requestedObservationPasses = Number(
    viteSetting("VITE_CCSWITCH_MAX_OBSERVATION_PASSES") ?? "2"
  );
  const maxObservationPasses = vision
    ? Math.min(
        2,
        Math.max(0, Number.isFinite(requestedObservationPasses) ? requestedObservationPasses : 2)
      )
    : 0;
  return {
    profile: ModelProfileSchema.parse({
      id: CCSWITCH_PROFILE_ID,
      label: "CCSwitch",
      protocol: "anthropic-compatible",
      execution: "local",
      baseUrl,
      // CCSwitch rewrites this placeholder to whichever provider/model is active locally.
      model: "ccswitch-active",
      capabilities: {
        vision,
        structuredOutput: "none",
        observationMode: maxObservationPasses > 0 ? "checkpoint" : "one-shot",
        maxObservationPasses,
        drawingPlanMode: "inline",
        reasoningMode:
          viteSetting("VITE_CCSWITCH_REASONING_MODE") === "provider-default"
            ? "provider-default"
            : "disabled",
        ...(vision ? {} : { supportedRoles: ["draw", "prompt", "review"] })
      },
      secretRef: CCSWITCH_PROFILE_ID,
      enabled: true
    }),
    apiKey: "local-proxy",
    remember: false
  };
}

function directDeepSeekRecord(): StoredModelProfile | undefined {
  if (!import.meta.env.DEV || typeof __DRAWGUESSAI_LOCAL_DEEPSEEK__ === "undefined") {
    return undefined;
  }
  const config = __DRAWGUESSAI_LOCAL_DEEPSEEK__;
  if (config === null) return undefined;
  return {
    profile: ModelProfileSchema.parse({
      id: DEEPSEEK_DIRECT_PROFILE_ID,
      label: "DeepSeek · Direct (text only)",
      protocol: "anthropic-compatible",
      execution: "local",
      baseUrl: config.baseUrl,
      model: config.model,
      capabilities: {
        vision: false,
        structuredOutput: "none",
        observationMode: "one-shot",
        maxObservationPasses: 0,
        drawingPlanMode: "inline",
        reasoningMode: "disabled",
        supportedRoles: ["draw", "prompt", "review"]
      },
      secretRef: DEEPSEEK_DIRECT_PROFILE_ID,
      enabled: true
    }),
    apiKey: config.apiKey,
    remember: false
  };
}

async function database() {
  return openDB(DB_NAME, 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "profile.id" });
      }
    }
  });
}

function readSession(): StoredModelProfile[] {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (typeof entry !== "object" || entry === null) return [];
      const profile = ModelProfileSchema.safeParse((entry as { profile?: unknown }).profile);
      if (!profile.success) return [];
      const apiKey = (entry as { apiKey?: unknown }).apiKey;
      return [
        {
          profile: profile.data,
          ...(typeof apiKey === "string" ? { apiKey } : {}),
          remember: (entry as { remember?: unknown }).remember === true
        }
      ];
    });
  } catch {
    return [];
  }
}

function writeSession(profiles: readonly StoredModelProfile[]): void {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(profiles));
}

export async function loadModelProfiles(): Promise<StoredModelProfile[]> {
  const sessionProfiles = readSession();
  let remembered: StoredModelProfile[];
  try {
    remembered = (await (await database()).getAll(STORE_NAME)) as StoredModelProfile[];
  } catch {
    remembered = [];
  }
  const merged = new Map<string, StoredModelProfile>();
  merged.set(DEMO_PROFILE.id, { profile: DEMO_PROFILE, remember: false });
  for (const record of remembered) merged.set(record.profile.id, record);
  for (const record of sessionProfiles) merged.set(record.profile.id, record);
  const localCcswitch = ccswitchRecord();
  if (localCcswitch !== undefined) merged.set(localCcswitch.profile.id, localCcswitch);
  const localDeepSeek = directDeepSeekRecord();
  if (localDeepSeek !== undefined) merged.set(localDeepSeek.profile.id, localDeepSeek);
  const result = [...merged.values()];
  writeSession(
    result.filter(
      (record) =>
        record.profile.id !== DEMO_PROFILE.id && !isBuiltInLocalProfileId(record.profile.id)
    )
  );
  return result;
}

export async function saveModelProfile(record: StoredModelProfile): Promise<void> {
  const parsed: StoredModelProfile = {
    profile: ModelProfileSchema.parse(record.profile),
    ...(record.apiKey === undefined ? {} : { apiKey: record.apiKey }),
    remember: record.remember
  };
  const session = readSession().filter((item) => item.profile.id !== parsed.profile.id);
  session.push(parsed);
  writeSession(session);
  const db = await database();
  if (parsed.remember) await db.put(STORE_NAME, parsed);
  else await db.delete(STORE_NAME, parsed.profile.id);
}

export async function deleteModelProfile(profileId: string): Promise<void> {
  if (profileId === DEMO_PROFILE.id || isBuiltInLocalProfileId(profileId)) return;
  writeSession(readSession().filter((item) => item.profile.id !== profileId));
  await (await database()).delete(STORE_NAME, profileId);
}

export function isModelProfileReady(record: StoredModelProfile): boolean {
  return (
    record.profile.enabled &&
    (record.profile.protocol === "demo" ||
      record.profile.execution === "server" ||
      (record.apiKey?.length ?? 0) > 0)
  );
}

export function preferredModelProfileId(profiles: readonly StoredModelProfile[]): string {
  const ready = profiles.filter(isModelProfileReady);
  const relayReady = ready.filter(
    (record) =>
      modelSupportsRole(record.profile.capabilities, "draw") &&
      modelSupportsRole(record.profile.capabilities, "guess")
  );
  return (
    relayReady.find((record) => record.profile.id === "server-minimax-m3")?.profile.id ??
    relayReady.find((record) => record.profile.id === CCSWITCH_PROFILE_ID)?.profile.id ??
    relayReady.find((record) => record.profile.model.toLowerCase().includes("minimax"))?.profile
      .id ??
    relayReady.find((record) => record.profile.protocol !== "demo")?.profile.id ??
    relayReady[0]?.profile.id ??
    DEMO_PROFILE.id
  );
}

export function secretFor(record: StoredModelProfile): ModelSecret | undefined {
  if (record.profile.protocol === "demo" || record.apiKey === undefined) return undefined;
  return {
    secretRef: record.profile.secretRef ?? record.profile.id,
    apiKey: record.apiKey
  };
}
