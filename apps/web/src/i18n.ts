import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import { en } from "./locales/en";
import { zhCN } from "./locales/zh-CN";
import { resolveInitialLocale } from "./lib/locale";

const savedLanguage = localStorage.getItem("drawguessai:locale");
const browserLanguages =
  navigator.languages.length > 0 ? navigator.languages : [navigator.language];
const initialLanguage = resolveInitialLocale(savedLanguage, browserLanguages);

void i18n.use(initReactI18next).init({
  resources: {
    "zh-CN": { translation: zhCN },
    en: { translation: en }
  },
  lng: initialLanguage,
  fallbackLng: "en",
  interpolation: { escapeValue: false }
});

export async function setLocale(locale: "zh-CN" | "en"): Promise<void> {
  localStorage.setItem("drawguessai:locale", locale);
  document.documentElement.lang = locale;
  await i18n.changeLanguage(locale);
}

document.documentElement.lang = i18n.language;

export default i18n;
