import axios from "axios";
import toast from "react-hot-toast";
import i18n from "../../i18n";
import { SSE } from "sse.js";
import {
  CommonTool,
  ConfigService,
  TokenService,
} from "../../assets/lib/kookit-extra-browser.min";
import { getServerRegion, reloadManager } from "../common";
import { clearServiceSession } from "./service";
import { isElectron } from "react-device-detect";
const PUBLIC_URL = "https://api.koodoreader.com";
const CN_PUBLIC_URL = "https://api.koodoreader.cn";
let cachedPluginList: any[] | null = null;
export const getPublicUrl = () => {
  return getServerRegion() === "china" ? CN_PUBLIC_URL : PUBLIC_URL;
};
export const checkDeveloperUpdate = async () => {
  let res = await axios.get(
    getPublicUrl() + `/api/update_dev?name=${navigator.language}`
  );
  return res.data.log;
};
export const getPluginList = async () => {
  if (cachedPluginList) {
    return cachedPluginList;
  }
  let res = await axios.get(
    getPublicUrl() + `/api/get_plugins?name=${navigator.language}`
  );
  cachedPluginList = res.data.plugins;
  return res.data.plugins;
};
export const uploadFile = async (url: string, file: any) => {
  return new Promise<boolean>((resolve) => {
    axios
      .put(url, file, {})
      .then(() => {
        resolve(true);
      })
      .catch((err) => {
        console.error(err);
        resolve(false);
      });
  });
};
export const checkStableUpdate = async () => {
  let res = await axios.get(
    getPublicUrl() + `/api/update?name=${navigator.language}`
  );
  return res.data.log;
};
export const handleExitApp = async () => {
  toast.error(i18n.t("Authorization failed, please login again"));
  await handleClearToken();
  //路由到login页面
  reloadManager();
};
export const handleClearToken = async () => {
  await clearServiceSession();
};

export const chatStream = async (
  url: string,
  providerId: string,
  apiKey: string,
  model: string,
  prompt: string,
  chat: any[],
  onMessage: (result) => void
) => {
  return new Promise<{ done: boolean }>((resolve, reject) => {
    const messages = [...chat, { role: "user", content: prompt }].slice(-5);
    const endpoint = url.replace(/\/+$/, "");
    const chatUrl = endpoint.endsWith("/chat/completions")
      ? endpoint
      : endpoint + "/chat/completions";
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (apiKey) headers.Authorization = "Bearer " + apiKey;
    const source = new SSE(chatUrl, {
      headers,
      payload: JSON.stringify({
        model,
        messages,
        stream: true,
        ...CommonTool.getDisableThinkingParams(providerId || ""),
      }),
      method: "POST",
    });

    source.addEventListener("open", () => {
      console.info("ChatStream connection established.");
    });

    source.addEventListener("message", (e: any) => {
      if (!e.data) return;
      if (e.data === "[DONE]") {
        source.close();
        resolve({ done: true });
        return;
      }
      try {
        const json = JSON.parse(e.data);
        const text = json?.choices?.[0]?.delta?.content;
        if (text) {
          onMessage({ text });
        }
      } catch (err) {
        console.error("ChatStream parse error:", err);
      }
    });

    source.addEventListener("error", (e: any) => {
      console.error("ChatStream error:", e);
      toast.error(e.data ? JSON.stringify(e.data) : "Unknown error", {
        id: "chat-stream-error",
        duration: 5000,
      });
      source.close();
      reject(e);
    });
  });
};
export const getNotification = async () => {
  let deviceUuid = await TokenService.getFingerprint();
  const res = await axios.post(
    "https://api.koodoreader.com/api/get_notification",
    {
      device_uuid: deviceUuid,
    }
  );
  // {
  // 	"result": "ok",
  // 	"unread": 0
  // }
  return res;
};
export const parseWithSystemOCR = async (imageBase64: string) => {
  if (!isElectron) {
    return;
  }
  const { ipcRenderer } = window.require("electron");
  let result = await ipcRenderer.invoke("system-ocr", {
    base64: imageBase64,
    lang: "auto",
  });
  return result.text || "";
};
