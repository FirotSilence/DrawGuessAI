export const FEATURED_REPLAY_TOKEN = "5FPPFTC3.ySGKoHUPi39iesa0pr2uKA";

const FEATURED_REPLAY_ASSETS: Readonly<Record<string, string>> = {
  [FEATURED_REPLAY_TOKEN]: `/featured-replays/${FEATURED_REPLAY_TOKEN}.json`
};

export function featuredReplayAssetPath(token: string): string | undefined {
  return FEATURED_REPLAY_ASSETS[token];
}
