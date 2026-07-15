export type SupportedLocale = "zh-CN" | "en";

export function resolveInitialLocale(
  savedLocale: string | null,
  preferredLanguages: readonly string[]
): SupportedLocale {
  if (savedLocale === "zh-CN" || savedLocale === "en") return savedLocale;

  for (const language of preferredLanguages) {
    const normalized = language.trim().toLowerCase();
    if (normalized.startsWith("zh")) return "zh-CN";
    if (normalized.startsWith("en")) return "en";
  }
  return "en";
}
