import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import translationEN from "./assets/locales/en.json";
import translationZHCN from "./assets/locales/zh-CN.json";

const localeFiles: Record<string, string> = {
  en: "en",
  zhCN: "zh-CN",
  zhTW: "zh-TW",
  zhMO: "zh-MO",
  ar: "ar",
  tr: "tr",
  ro: "ro",
  pl: "pl",
  cs: "cs",
  ja: "ja",
  ta: "ta",
  uk: "uk",
  sl: "sl",
  bo: "bo",
  id: "id",
  hy: "hy",
  el: "el",
  hu: "hu",
  hi: "hi",
  bg: "bg",
  it: "it",
  bn: "bn",
  tl: "tl",
  sv: "sv",
  ga: "ga",
  nl: "nl",
  ko: "ko",
  de: "de",
  ru: "ru",
  fr: "fr",
  es: "es",
  fa: "fa",
  ptBR: "pt-BR",
  th: "th",
  sr: "sr",
  am: "am",
  da: "da",
  fi: "fi",
  ie: "ie",
  pt: "pt",
  vi: "vi",
};

type LocaleCallback = (error: Error | null, translations?: object) => void;

const localeBackend = {
  type: "backend" as const,
  init: () => undefined,
  read: (language: string, _namespace: string, callback: LocaleCallback) => {
    if (language === "zhCN") {
      callback(null, translationZHCN);
      return;
    }
    if (language === "en") {
      callback(null, translationEN);
      return;
    }

    const file = localeFiles[language];
    if (!file) {
      callback(new Error(`Unsupported locale: ${language}`));
      return;
    }

    import(`./assets/locales/${file}.json`)
      .then((module) => callback(null, module.default || module))
      .catch((error) =>
        callback(error instanceof Error ? error : new Error(String(error)))
      );
  },
};

i18n
  .use(localeBackend as any)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: translationEN },
      zhCN: { translation: translationZHCN },
    },
    partialBundledLanguages: true,
    lng: "zhCN",
    fallbackLng: "en",
    keySeparator: false,
    interpolation: {
      escapeValue: false,
    },
  });

export default i18n;
