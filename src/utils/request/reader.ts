import toast from "react-hot-toast";
import { ConfigService, TokenService } from "../../assets/lib/kookit-extra-browser.min";
import i18n from "../../i18n";
import { chatStream } from "./common";
import {
  ApiResponse,
  hasServiceCapability,
  ServiceCapability,
  serviceRequest,
  serviceStream,
} from "./service";

interface LocalModel {
  key: string;
  endpoint: string;
  modelsEndpoint?: string;
  modelId: string;
  providerId: string;
  apiKey: string;
  capabilities: string[];
}

const result = <T>(code: number, msg: string, data?: T): ApiResponse<T> => ({
  code,
  msg,
  data: data as T,
});

const featureModelKeys: Record<string, string> = {
  translation: "aiTranslateModel",
  dictionary: "aiDictModel",
  assistant: "aiAssistanceModel",
  vision: "aiVisionModel",
  tts: "aiTtsModel",
};

const getLocalModel = async (feature: keyof typeof featureModelKeys) => {
  const key = ConfigService.getReaderConfig(featureModelKeys[feature]);
  if (!key) return null;
  const entry = ConfigService.getObjectConfig(key, "aiModelConfig", null);
  if (!entry?.config) return null;
  const config = { ...entry.config };
  let apiKey = (await TokenService.getToken(`ai_model_key_${key}`)) || "";
  if (!apiKey && config.apiKey) {
    apiKey = config.apiKey;
    await TokenService.setToken(`ai_model_key_${key}`, apiKey);
    delete config.apiKey;
    ConfigService.setObjectConfig(
      key,
      { ...entry, config },
      "aiModelConfig"
    );
  }
  return {
    key,
    endpoint: String(config.endpoint || "").replace(/\/+$/, ""),
    modelsEndpoint: config.modelsEndpoint || "",
    modelId: config.modelId || "",
    providerId: config.providerId || "custom",
    apiKey,
    capabilities: config.capabilities || ["chat"],
  } as LocalModel;
};

const chatEndpoint = (endpoint: string) =>
  endpoint.endsWith("/chat/completions")
    ? endpoint
    : endpoint + "/chat/completions";

const localChat = async (
  feature: keyof typeof featureModelKeys,
  prompt: string,
  extraMessages: any[] = []
): Promise<ApiResponse<string>> => {
  const model = await getLocalModel(feature);
  if (!model?.endpoint || !model.modelId) {
    return result(422, i18n.t("Please configure an AI model for this feature"));
  }
  if (!model.capabilities.includes("chat")) {
    return result(422, i18n.t("The selected model does not provide chat capability"));
  }
  try {
    const response = await fetch(chatEndpoint(model.endpoint), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(model.apiKey ? { Authorization: `Bearer ${model.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: model.modelId,
        messages: [...extraMessages, { role: "user", content: prompt }],
      }),
    });
    if (!response.ok) return result(response.status, response.statusText);
    const data = await response.json();
    return result(200, "success", data.choices?.[0]?.message?.content || "");
  } catch (error) {
    return result(503, error instanceof Error ? error.message : "AI unavailable");
  }
};

const parseJson = <T>(value: string, fallback: T): T => {
  try {
    const cleaned = value
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "");
    return JSON.parse(cleaned) as T;
  } catch {
    return fallback;
  }
};

const serviceFirst = async <T>(
  capability: ServiceCapability,
  path: string,
  body: any,
  fallback: () => Promise<ApiResponse<T>>
): Promise<ApiResponse<T>> => {
  if (await hasServiceCapability(capability)) {
    const response = await serviceRequest<T>(path, {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (response.code === 200) return response;
  }
  return fallback();
};

const streamData = (value: string, onMessage: (result: any) => void) => {
  try {
    onMessage(JSON.parse(value));
  } catch {
    onMessage({ text: value });
  }
};

const localStream = async (
  feature: "translation" | "dictionary" | "assistant",
  prompt: string,
  history: any[],
  onMessage: (result: any) => void
) => {
  const model = await getLocalModel(feature);
  if (!model?.endpoint || !model.modelId) {
    toast.error(i18n.t("Please configure an AI model for this feature"));
    return result<null>(422, "AI model is not configured");
  }
  if (!model.capabilities.includes("chat")) {
    toast.error(i18n.t("The selected model does not provide chat capability"));
    return result<null>(422, "Chat capability is not configured");
  }
  try {
    await chatStream(
      model.endpoint,
      model.providerId,
      model.apiKey,
      model.modelId,
      prompt,
      history,
      onMessage
    );
    return result<null>(200, "success", null);
  } catch (error) {
    return result<null>(503, error instanceof Error ? error.message : "AI unavailable");
  }
};

export const getTransStream = async (
  text: string,
  from: string,
  to: string,
  onMessage: (result: any) => void
) => {
  if (await hasServiceCapability("reader.translation")) {
    const response = await serviceStream(
      "/v1/reader/translation/stream",
      { text, from, to },
      (data) => streamData(data, onMessage)
    );
    if (response.code === 200) return response;
  }
  const prompt =
    (ConfigService.getReaderConfig("aiTranslatePrompt") ||
      "Translate the following text from {from} to {to}. Return only the translation:\n{text}")
      .replace("{from}", from)
      .replace("{to}", to)
      .replace("{text}", text);
  return localStream("translation", prompt, [], onMessage);
};

export const getAnswerStream = async (
  text: string,
  question: string,
  history: any[],
  mode: string,
  onMessage: (result: any) => void
) => {
  if (await hasServiceCapability("reader.assistant")) {
    const response = await serviceStream(
      "/v1/reader/assistant/stream",
      { text, question, history: history.slice(-5), mode },
      (data) => streamData(data, onMessage)
    );
    if (response.code === 200) return response;
  }
  const template =
    ConfigService.getReaderConfig("aiAssistancePrompt") ||
    "Use the following reading context to answer the question.\nContext: {text}";
  return localStream(
    "assistant",
    template.replace("{text}", text) + `\nQuestion: ${question}`,
    history.slice(-5),
    onMessage
  );
};

export const getDictionaryStream = async (
  word: string,
  from: string,
  to: string,
  sentence: string,
  isFullAnalysis: boolean,
  onMessage: (result: any) => void
) => {
  if (await hasServiceCapability("reader.dictionary")) {
    const response = await serviceStream(
      "/v1/reader/dictionary/stream",
      { word, from, to, sentence, is_full_analysis: isFullAnalysis },
      (data) => streamData(data, onMessage)
    );
    if (response.code === 200) return response;
  }
  const template =
    ConfigService.getReaderConfig("aiDictPrompt") ||
    "Explain {word} in {to}, considering this sentence: {sentence}.";
  return localStream(
    "dictionary",
    template
      .replace("{word}", word)
      .replace("{from}", from)
      .replace("{to}", to)
      .replace("{sentence}", sentence),
    [],
    onMessage
  );
};

export const getDictionary = async (word: string, from: string, to: string) =>
  serviceFirst<any[]>(
    "reader.dictionary",
    "/v1/reader/dictionary",
    { word, from, to },
    async () => {
      const response = await localChat(
        "dictionary",
        `Define "${word}" from ${from} in ${to}. Return a JSON array with pronunciation, audio, form, meaning (type, definition, examples), and comparison fields.`
      );
      return result(
        response.code,
        response.msg,
        parseJson<any[]>(response.data || "", [])
      );
    }
  );

export const getDictText = async (word: string, from: string, to: string) => {
  if (from === "en") from = "eng";
  const res = await getDictionary(word, from, to);
  if (res.code !== 200 || !res.data?.length) return "";
  const item: any = res.data[0];
  const meanings = Array.isArray(item.meaning) ? item.meaning : [];
  return (
    `<p class="dict-word-type">[${i18n.t("Pronunciations")}]</p>` +
    (item.pronunciation || "") +
    (item.audio
      ? `<div class="audio-container"><audio controls preload="auto" class="audio-player" controlsList="nodownload noplaybackrate"><source src="${item.audio}" type="audio/mpeg"></audio></div>`
      : "") +
    (item.form?.length
      ? `<p class="dict-word-type">[${i18n.t("Inflection")}]</p>${Array.from(new Set(item.form)).join(", ")}`
      : "") +
    meanings
      .map(
        (meaning: any) =>
          `${meaning.type ? `<p class="dict-word-type">[${meaning.type}]</p>` : ""}<div style="font-weight: bold">${meaning.definition || ""}</div>`
      )
      .join("") +
    `<p class="dict-learn-more">${i18n.t("Generated with AI")}</p>`
  );
};

const localVision = async (imageBase64: string) => {
  const model = await getLocalModel("vision");
  if (!model?.endpoint || !model.modelId) {
    return result<any>(422, i18n.t("Please configure a vision model"));
  }
  if (!model.capabilities.includes("vision")) {
    return result<any>(422, i18n.t("The selected model does not provide vision capability"));
  }
  try {
    const response = await fetch(chatEndpoint(model.endpoint), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(model.apiKey ? { Authorization: `Bearer ${model.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: model.modelId,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Extract all text from this image. Return plain text only." },
              { type: "image_url", image_url: { url: imageBase64 } },
            ],
          },
        ],
      }),
    });
    if (!response.ok) return result<any>(response.status, response.statusText);
    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || "";
    return result(200, "success", { text });
  } catch (error) {
    return result<any>(503, error instanceof Error ? error.message : "OCR unavailable");
  }
};

export const getOcrResult = async (imageBase64: string) =>
  serviceFirst<any>(
    "reader.ocr",
    "/v1/reader/ocr",
    { image_base64: imageBase64 },
    () => localVision(imageBase64)
  );

export const getOcrResultV2 = async (file: any) => {
  const imageBase64 =
    typeof file === "string"
      ? file
      : await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || ""));
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(file);
        });
  return getOcrResult(imageBase64);
};

const arrayBufferToBase64 = (buffer: ArrayBuffer) => {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  bytes.forEach((byte) => (binary += String.fromCharCode(byte)));
  return `data:audio/mpeg;base64,${btoa(binary)}`;
};

const localTts = async (text: string, voice: string, speed: number) => {
  const model = await getLocalModel("tts");
  if (!model?.endpoint || !model.modelId) {
    return result<any>(422, i18n.t("Please configure a TTS model"));
  }
  if (!model.capabilities.includes("tts")) {
    return result<any>(422, i18n.t("The selected model does not provide TTS capability"));
  }
  const endpoint = model.endpoint.endsWith("/audio/speech")
    ? model.endpoint
    : model.endpoint + "/audio/speech";
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(model.apiKey ? { Authorization: `Bearer ${model.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: model.modelId, input: text, voice, speed }),
    });
    if (!response.ok) return result<any>(response.status, response.statusText);
    return result(200, "success", {
      audio_base64: arrayBufferToBase64(await response.arrayBuffer()),
    });
  } catch (error) {
    return result<any>(503, error instanceof Error ? error.message : "TTS unavailable");
  }
};

export const getTTSAudio = async (
  text: string,
  language: string,
  voice: string,
  speed: number,
  pitch: number,
  isFirst: boolean
) =>
  {
    const response = await serviceFirst<any>(
    "reader.tts",
    "/v1/reader/tts",
    { text, language, voice, speed, pitch, is_first: isFirst },
    () => localTts(text, voice, speed)
  );
    const audio = response.data?.audio_base64;
    if (
      response.code === 200 &&
      audio &&
      !/^(data:|blob:|https?:|file:)/i.test(audio)
    ) {
      const mimeType = response.data?.mime_type || "audio/mpeg";
      response.data.audio_base64 = `data:${mimeType};base64,${audio}`;
    }
    return response;
  };

export const getBatchTrans = async (texts: string[], from: string, to: string) =>
  serviceFirst<any>(
    "reader.batch-translation",
    "/v1/reader/batch-translation",
    { texts, from, to },
    async () => {
      const response = await localChat(
        "translation",
        `Translate each string from ${from} to ${to}. Return only JSON: {"texts":[...]}. Input: ${JSON.stringify(texts)}`
      );
      return result(response.code, response.msg, parseJson(response.data || "", { texts: [] }));
    }
  );

export const getWordDefinitions = async (
  texts: string[],
  level: string,
  lang: string
) =>
  serviceFirst<any>(
    "reader.word-definitions",
    "/v1/reader/word-definitions",
    { texts, level, lang },
    async () => {
      const response = await localChat(
        "dictionary",
        `Find words above ${level} in these ${lang} texts and explain them. Return JSON with the same schema expected by a reading word-definition tool: ${JSON.stringify(texts)}`
      );
      return result(response.code, response.msg, parseJson(response.data || "", {}));
    }
  );

export const getBookMetadata = async (name: string, author: string) =>
  serviceFirst<any[]>(
    "reader.metadata",
    "/v1/reader/metadata",
    { name, author },
    async () => {
      const response = await localChat(
        "assistant",
        `Find metadata candidates for a book named "${name}" by "${author}". Return only a JSON array of objects containing id, title, author, publisher, description, cover, isbn and language.`
      );
      return result(response.code, response.msg, parseJson(response.data || "", []));
    }
  );

export const getSplitSentence = async (texts: { text: string; index: number }[]) =>
  serviceFirst<any>(
    "reader.role-analysis",
    "/v1/reader/role-analysis",
    { texts },
    async () => {
      const response = await localChat(
        "assistant",
        `Split dialogue and narration, preserving input indexes. Classify role as narrator, male, female or child. Return only JSON {"sentences":[{"text":"","index":0,"role":"narrator"}]}. Input: ${JSON.stringify(texts)}`
      );
      return result(response.code, response.msg, parseJson(response.data || "", { sentences: [] }));
    }
  );

export const detectLanguage = async (text: string) =>
  serviceFirst<any>(
    "reader.language-detect",
    "/v1/reader/language-detect",
    { text },
    async () => {
      const response = await localChat(
        "assistant",
        `Detect the ISO 639-1 language code. Return only JSON {"language":"xx"}. Text: ${text.slice(0, 2000)}`
      );
      return result(response.code, response.msg, parseJson(response.data || "", { language: "" }));
    }
  );
