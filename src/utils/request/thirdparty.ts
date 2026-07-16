import toast from "react-hot-toast";
import { ConfigService, TokenService } from "../../assets/lib/kookit-extra-browser.min";
import i18n from "../../i18n";
import {
  ApiResponse,
  canUseBoundOnlineSync,
  getServiceHealth,
  serviceRequest,
} from "./service";

interface OAuthToken {
  access_token?: string;
  refresh_token: string;
  expires_in?: number;
  [key: string]: any;
}

export interface SyncItem {
  type: string;
  content: string;
  version: number;
  updated_at: number | string;
}

const ok = <T>(data: T): ApiResponse<T> => ({
  code: 200,
  msg: "success",
  data,
});

const unsupported = <T>(msg: string): ApiResponse<T> => ({
  code: 410,
  msg,
  data: undefined as T,
});

const checkOnlineCapability = async <T>(
  capability: "sync.data" | "storage.oauth"
): Promise<ApiResponse<T>> => {
  if (capability === "sync.data" && !(await canUseBoundOnlineSync())) {
    return unsupported<T>("Online sync is not available for this account");
  }
  const health = await getServiceHealth();
  if (health.code !== 200) {
    return {
      code: health.code,
      msg: health.msg,
      data: undefined as T,
    };
  }
  if (!health.data.capabilities.includes(capability)) {
    return unsupported<T>(`Service capability ${capability} is not available`);
  }
  return ok(undefined as T);
};

export const getOnlineSyncItem = async (
  type: string
): Promise<ApiResponse<SyncItem>> => {
  const available = await checkOnlineCapability<SyncItem>("sync.data");
  if (available.code !== 200) return available;
  return serviceRequest<SyncItem>(`/v1/sync/${encodeURIComponent(type)}`, {
    method: "GET",
  });
};

export const putOnlineSyncItems = async (
  items: Record<string, string>,
  versions: Record<string, number>
): Promise<ApiResponse<Record<string, SyncItem>>> => {
  const available = await checkOnlineCapability<Record<string, SyncItem>>(
    "sync.data"
  );
  if (available.code !== 200) {
    return available;
  }
  return serviceRequest<Record<string, SyncItem>>("/v1/sync", {
    method: "PUT",
    body: JSON.stringify({ items, versions }),
  });
};

export const encryptToken = async (service: string, config: any) => {
  const value = `local-v1:${JSON.stringify(config)}`;
  await TokenService.setToken(service + "_token", value);
  ConfigService.removeItem(service + "_needsReconnect");
  return ok({ encrypted_token: value });
};

export const decryptToken = async (service: string) => {
  const stored = await TokenService.getToken(service + "_token");
  if (!stored || stored === "{}") return ok({ token: "{}" });
  if (stored.startsWith("local-v1:")) {
    ConfigService.removeItem(service + "_needsReconnect");
    return ok({ token: stored.slice("local-v1:".length) || "{}" });
  }
  try {
    JSON.parse(stored);
    const migrated = `local-v1:${stored}`;
    await TokenService.setToken(service + "_token", migrated);
    ConfigService.removeItem(service + "_needsReconnect");
    return ok({ token: stored });
  } catch {
    ConfigService.setItem(service + "_needsReconnect", "yes");
    return {
      code: 410,
      msg: i18n.t("This data source needs to be reconnected"),
      data: { token: "{}", needs_reconnect: true },
    };
  }
};

export const getCloudSyncToken = async () => {
  const defaultSyncOption = ConfigService.getItem("defaultSyncOption") || "";
  const defaultSyncToken = defaultSyncOption
    ? await TokenService.getToken(defaultSyncOption + "_token")
    : "";
  return ok({
    default_sync_option: defaultSyncOption,
    default_sync_token: defaultSyncToken || "",
  });
};

export const authorizeThirdProvider = async (
  provider: string,
  redirectUri: string
) => {
  const available = await checkOnlineCapability<{
    authorization_url: string;
    state: string;
  }>("storage.oauth");
  if (available.code !== 200) {
    return available;
  }
  return serviceRequest<{ authorization_url: string; state: string }>(
    "/v1/storage/oauth/authorize",
    {
      method: "POST",
      body: JSON.stringify({ provider, redirect_uri: redirectUri }),
    }
  );
};

export const authThirdToken = async (
  provider: string,
  code: string,
  redirectUri: string
): Promise<ApiResponse<OAuthToken>> => {
  const response = await serviceRequest<OAuthToken>(
    "/v1/storage/oauth/exchange",
    {
      method: "POST",
      body: JSON.stringify({
        provider: provider === "microsoft_exp" ? "microsoft" : provider,
        code,
        redirect_uri: redirectUri,
      }),
    }
  );
  if (response.code !== 200) {
    toast.error(
      i18n.t("Authorization failed, error code") + ": " + response.msg
    );
  }
  return response;
};

export const refreshThirdToken = async (
  provider: string,
  refresh_token: string
): Promise<ApiResponse<OAuthToken>> => {
  const response = await serviceRequest<OAuthToken>(
    "/v1/storage/oauth/refresh",
    {
      method: "POST",
      body: JSON.stringify({
        provider: provider === "microsoft_exp" ? "microsoft" : provider,
        refresh_token,
      }),
    }
  );
  if (response.code !== 200) {
    toast.error(
      i18n.t("Authorization failed, error code") + ": " + response.msg
    );
  }
  return response;
};

export const onSyncCallback = async (service: string, authCode: string) => {
  toast.loading(i18n.t("Adding"), { id: "adding-sync-id" });
  const redirectUri = window.location.origin + "/redirect";
  const response = await authThirdToken(service, authCode, redirectUri);
  if (response.code !== 200 || !response.data?.refresh_token) {
    toast.error(i18n.t("Authorization failed"), { id: "adding-sync-id" });
    return response;
  }
  const result = await encryptToken(service, {
    ...response.data,
    service,
    version: 2,
    auth_date: Date.now(),
    expires_at: response.data.expires_in
      ? Date.now() + response.data.expires_in * 1000
      : 0,
  });
  ConfigService.setListConfig(service, "dataSourceList");
  toast.success(i18n.t("Binding successful"), { id: "adding-sync-id" });
  return result;
};
