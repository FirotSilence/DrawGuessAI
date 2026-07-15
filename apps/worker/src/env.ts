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
  MINIMAX_API_KEY?: string;
  MINIMAX_BASE_URL?: string;
  MINIMAX_MODEL?: string;
  MINIMAX_MAX_OBSERVATION_PASSES?: string;
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
}
