export interface Env {
  ROOMS: DurableObjectNamespace;
  ASSETS: Fetcher;
  AI?: Ai;
  ROOM_CREATION_RATE_LIMITER?: RateLimit;
  ROOM_JOIN_RATE_LIMITER?: RateLimit;
  AI_RATE_LIMITER?: RateLimit;
  CREDENTIAL_RATE_LIMITER?: RateLimit;
  APP_VERSION: string;
  APP_ORIGIN: string;
  ROOM_IDLE_SECONDS: string;
  SERVER_AI_PROFILES_JSON?: string;
  WORKERS_AI_PROFILES_JSON?: string;
  SERVER_AI_API_KEY?: string;
  SERVER_AI_PROFILE_ID?: string;
  SERVER_AI_LABEL?: string;
  SERVER_AI_PROTOCOL?: string;
  SERVER_AI_AUTH_MODE?: string;
  SERVER_AI_BASE_URL?: string;
  SERVER_AI_MODEL?: string;
  SERVER_AI_VISION?: string;
  SERVER_AI_STRUCTURED_OUTPUT?: string;
  SERVER_AI_MAX_OBSERVATION_PASSES?: string;
  SERVER_AI_DRAWING_PLAN_MODE?: string;
  SERVER_AI_REASONING_MODE?: string;
  SERVER_AI_SUPPORTED_ROLES?: string;
  // Backwards-compatible aliases for deployments created before generic server profiles.
  MINIMAX_API_KEY?: string;
  MINIMAX_BASE_URL?: string;
  MINIMAX_MODEL?: string;
  MINIMAX_MAX_OBSERVATION_PASSES?: string;
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
}
