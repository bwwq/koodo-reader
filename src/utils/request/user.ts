import {
  browserName,
  browserVersion,
  isElectron,
  osName,
  osVersion,
} from "react-device-detect";
import { ConfigService, TokenService } from "../../assets/lib/kookit-extra-browser.min";
import packageJson from "../../../package.json";
import {
  ApiResponse,
  ServiceUser,
} from "./service";

declare var window: any;

export interface ServiceDevice {
  name: string;
  type: "Desktop" | "Browser";
  os: string;
  os_version: string;
  locale: string;
  uuid: string;
  app_version: string;
}

export const getDeviceName = async (): Promise<string> => {
  if (isElectron) {
    try {
      const { ipcRenderer } = window.require("electron");
      const name = await ipcRenderer.invoke("get-device-name");
      return name?.trim() || "Desktop";
    } catch {
      return "Desktop";
    }
  }
  return detectBrowser();
};

export const getServiceDevice = async (): Promise<ServiceDevice> => ({
  name: await getDeviceName(),
  type: isElectron ? "Desktop" : "Browser",
  os: getOSName(),
  os_version: getOsVersionNumber(),
  locale: navigator.language,
  uuid: await TokenService.getFingerprint(),
  app_version: packageJson.version,
});

/**
 * Compatibility adapter for older callers while the UI is migrated. It never
 * contacts the former Koodo account service.
 */
export const updateUserConfig = async (config: any) => {
  if (Object.prototype.hasOwnProperty.call(config, "is_enable_koodo_sync")) {
    ConfigService.setReaderConfig(
      "isEnableOnlineSync",
      config.is_enable_koodo_sync === "yes" ? "yes" : "no"
    );
  }
  return { code: 200, msg: "success", data: null } as ApiResponse<null>;
};

export const getOSName = () => (isElectron ? osName : browserName);

export const detectBrowser = () => {
  const userAgent = navigator.userAgent;
  if (userAgent.indexOf("Edg") > -1) return "Microsoft Edge";
  if (userAgent.indexOf("Chrome") > -1) return "Chrome";
  if (userAgent.indexOf("Firefox") > -1) return "Firefox";
  if (userAgent.indexOf("Safari") > -1) return "Safari";
  if (userAgent.indexOf("Opera") > -1) return "Opera";
  if (userAgent.indexOf("Trident") > -1 || userAgent.indexOf("MSIE") > -1) {
    return "Internet Explorer";
  }
  return "Unknown";
};

export const getOsVersionNumber = (): string =>
  isElectron ? osVersion : browserVersion;

export type { ServiceUser };
