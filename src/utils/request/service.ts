import {
  ConfigService,
  TokenService,
} from "../../assets/lib/kookit-extra-browser.min";

export type ServiceCapability =
  | "reader.translation"
  | "reader.assistant"
  | "reader.dictionary"
  | "reader.ocr"
  | "reader.tts"
  | "reader.batch-translation"
  | "reader.word-definitions"
  | "reader.metadata"
  | "reader.role-analysis"
  | "reader.language-detect"
  | "sync.data"
  | "sync.koreader"
  | "storage.files"
  | "source.search"
  | "source.legado"
  | "source.sonovel"
  | "source.webview"
  | "source.comic"
  | "storage.oauth";

export interface ApiResponse<T> {
  code: number;
  msg: string;
  data: T;
}

export interface ServiceUser {
  id: string;
  username: string;
  displayName?: string;
  role?: "admin" | "user";
}

export interface ServiceHealth {
  version: string;
  capabilities: ServiceCapability[];
}

export interface AuthConfig {
  registration_mode: "bootstrap" | "admin" | "invite";
  service_name?: string;
}

export interface AdminConfig {
  registration_mode: "admin" | "invite";
  service_name: string;
  capabilities: ServiceCapability[];
  koreader_registration_enabled: boolean;
}

export interface AdminInvite {
  code_hint: string;
  created_at: number;
  expires_at: number;
  status: "available" | "used" | "expired" | "revoked";
}

interface TokenPayload {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user?: {
    id: string;
    username: string;
    display_name?: string;
    displayName?: string;
    role?: "admin" | "user";
  };
}

const ACCESS_TOKEN_KEY = "service_access_token";
const REFRESH_TOKEN_KEY = "service_refresh_token";
const TOKEN_EXPIRES_KEY = "service_token_expires_at";
const USER_KEY = "service_user";
const LEGACY_AUTH_KEY = "is_authed";

let refreshPromise: Promise<boolean> | null = null;
let capabilityCache: ServiceHealth | null = null;
let sessionGeneration = 0;

export const normalizeServiceBaseUrl = (value: string): string => {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  const parsed = new URL(trimmed);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Service address must use HTTP or HTTPS");
  }
  return parsed.toString().replace(/\/$/, "");
};

export const getServiceBaseUrl = (): string => {
  const value = ConfigService.getItem("serviceBaseUrl") || "";
  try {
    return normalizeServiceBaseUrl(value);
  } catch {
    return "";
  }
};

export const setServiceBaseUrl = async (value: string): Promise<string> => {
  const normalized = normalizeServiceBaseUrl(value);
  const previous = getServiceBaseUrl();
  if (previous !== normalized) {
    await clearServiceSession();
    resetServiceCache();
  }
  ConfigService.setItem("serviceBaseUrl", normalized);
  return normalized;
};

export const resetServiceCache = () => {
  capabilityCache = null;
};

const emptyResponse = <T>(code: number, msg: string): ApiResponse<T> => ({
  code,
  msg,
  data: undefined as T,
});

const normalizeUser = (user: TokenPayload["user"]): ServiceUser | null => {
  if (!user || !user.id || !user.username) return null;
  return {
    id: String(user.id),
    username: user.username,
    displayName: user.displayName || user.display_name || "",
    role: user.role,
  };
};

const saveSession = async (payload: TokenPayload) => {
  await TokenService.setToken(ACCESS_TOKEN_KEY, payload.access_token || "");
  await TokenService.setToken(REFRESH_TOKEN_KEY, payload.refresh_token || "");
  await TokenService.setToken(
    TOKEN_EXPIRES_KEY,
    String(Date.now() + Math.max(payload.expires_in || 900, 30) * 1000)
  );
  const user = normalizeUser(payload.user);
  if (user) {
    await TokenService.setToken(USER_KEY, JSON.stringify(user));
  }
  await TokenService.setToken(LEGACY_AUTH_KEY, "");
};

export const clearServiceSession = async () => {
  sessionGeneration++;
  // TokenService rewrites one encrypted token object for every operation.
  // Parallel deletes race and can restore keys removed by another delete.
  for (const key of [
    ACCESS_TOKEN_KEY,
    REFRESH_TOKEN_KEY,
    TOKEN_EXPIRES_KEY,
    USER_KEY,
    LEGACY_AUTH_KEY,
    "access_token",
    "refresh_token",
  ]) {
    await TokenService.deleteToken(key);
  }
};

export const getStoredServiceUser = async (): Promise<ServiceUser | null> => {
  const value = await TokenService.getToken(USER_KEY);
  if (!value) return null;
  try {
    const user = JSON.parse(value);
    if (!user.id || !user.username) return null;
    return user as ServiceUser;
  } catch {
    return null;
  }
};

export const isServiceSessionConnected = async (): Promise<boolean> => {
  if (!getServiceBaseUrl()) return false;
  return Boolean(await getServiceAccessToken());
};

export const getBoundSyncUserId = (): string =>
  ConfigService.getItem("boundSyncUserId") || "";

export const getBoundSyncServiceBaseUrl = (): string =>
  ConfigService.getItem("boundSyncServiceBaseUrl") || "";

export const bindSyncToCurrentUser = async (): Promise<boolean> => {
  const user = await getStoredServiceUser();
  if (!user) return false;
  const current = getBoundSyncUserId();
  const currentService = getBoundSyncServiceBaseUrl();
  const serviceBaseUrl = getServiceBaseUrl();
  if (current && current !== user.id) return false;
  if (currentService && currentService !== serviceBaseUrl) return false;
  ConfigService.setItem("boundSyncUserId", user.id);
  ConfigService.setItem("boundSyncServiceBaseUrl", serviceBaseUrl);
  ConfigService.setReaderConfig("isEnableOnlineSync", "yes");
  return true;
};

export const canUseBoundOnlineSync = async (): Promise<boolean> => {
  if (ConfigService.getReaderConfig("isEnableOnlineSync") !== "yes") {
    return false;
  }
  const user = await getStoredServiceUser();
  return Boolean(
    user &&
      getBoundSyncUserId() === user.id &&
      getBoundSyncServiceBaseUrl() === getServiceBaseUrl()
  );
};

const parseResponse = async <T>(response: Response): Promise<ApiResponse<T>> => {
  let body: any = null;
  try {
    body = await response.json();
  } catch {
    return emptyResponse<T>(response.status || 500, response.statusText);
  }
  if (typeof body?.code === "number") {
    return body as ApiResponse<T>;
  }
  if (!response.ok) {
    return emptyResponse<T>(response.status, body?.message || response.statusText);
  }
  return { code: 200, msg: "success", data: body as T };
};

const performSessionRefresh = async (): Promise<boolean> => {
  const generation = sessionGeneration;
  const baseUrl = getServiceBaseUrl();
  const refreshToken = await TokenService.getToken(REFRESH_TOKEN_KEY);
  if (!baseUrl || !refreshToken) return false;
  try {
    const response = await fetch(baseUrl + "/v1/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    const result = await parseResponse<TokenPayload>(response);
    if (result.code !== 200 || !result.data?.access_token) {
      const latestRefreshToken = await TokenService.getToken(REFRESH_TOKEN_KEY);
      return Boolean(latestRefreshToken && latestRefreshToken !== refreshToken);
    }
    if (generation !== sessionGeneration) return false;
    await saveSession(result.data);
    return true;
  } catch {
    return false;
  }
};

const refreshSession = async (force = false): Promise<boolean> => {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const initialAccessToken = await TokenService.getToken(ACCESS_TOKEN_KEY);
    const initialRefreshToken = await TokenService.getToken(REFRESH_TOKEN_KEY);
    const refresh = async () => {
      const currentAccessToken = await TokenService.getToken(ACCESS_TOKEN_KEY);
      const currentRefreshToken = await TokenService.getToken(REFRESH_TOKEN_KEY);
      if (
        (currentAccessToken && currentAccessToken !== initialAccessToken) ||
        (currentRefreshToken && currentRefreshToken !== initialRefreshToken)
      ) {
        return true;
      }
      const expiresAt = Number(
        (await TokenService.getToken(TOKEN_EXPIRES_KEY)) || "0"
      );
      if (
        !force &&
        currentAccessToken &&
        (!expiresAt || expiresAt >= Date.now() + 30_000)
      ) {
        return true;
      }
      return performSessionRefresh();
    };
    const locks =
      typeof navigator !== "undefined" ? (navigator as any).locks : null;
    if (locks?.request) {
      return locks.request("koodo-service-session-refresh", refresh);
    }
    return refresh();
  })().finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
};

interface RequestOptions extends RequestInit {
  authenticated?: boolean;
  retryAuth?: boolean;
}

export const serviceRequest = async <T>(
  path: string,
  options: RequestOptions = {}
): Promise<ApiResponse<T>> => {
  const baseUrl = getServiceBaseUrl();
  if (!baseUrl) return emptyResponse<T>(400, "Online service is not configured");

  const authenticated = options.authenticated !== false;
  const headers = new Headers(options.headers || {});
  if (
    !(typeof FormData !== "undefined" && options.body instanceof FormData) &&
    !headers.has("Content-Type")
  ) {
    headers.set("Content-Type", "application/json");
  }
  if (authenticated) {
    const expiresAt = Number(
      (await TokenService.getToken(TOKEN_EXPIRES_KEY)) || "0"
    );
    let accessToken = await TokenService.getToken(ACCESS_TOKEN_KEY);
    if (
      (!accessToken || (expiresAt && expiresAt < Date.now() + 30_000)) &&
      (await refreshSession())
    ) {
      accessToken = await TokenService.getToken(ACCESS_TOKEN_KEY);
    }
    if (!accessToken) {
      return emptyResponse<T>(401, "登录状态已失效，请重新登录");
    }
    headers.set("Authorization", `Bearer ${accessToken}`);
  }

  try {
    const response = await fetch(baseUrl + path, { ...options, headers });
    const result = await parseResponse<T>(response);
    if (
      authenticated &&
      (response.status === 401 || result.code === 401) &&
      options.retryAuth !== false &&
      (await refreshSession(true))
    ) {
      return serviceRequest<T>(path, { ...options, retryAuth: false });
    }
    if (authenticated && (response.status === 401 || result.code === 401)) {
      const latestAccessToken = await TokenService.getToken(ACCESS_TOKEN_KEY);
      const requestAccessToken = headers
        .get("Authorization")
        ?.replace(/^Bearer\s+/i, "");
      if (
        options.retryAuth !== false &&
        latestAccessToken &&
        latestAccessToken !== requestAccessToken
      ) {
        return serviceRequest<T>(path, { ...options, retryAuth: false });
      }
      if (!latestAccessToken || latestAccessToken === requestAccessToken) {
        await clearServiceSession();
      }
    }
    return result;
  } catch (error) {
    return emptyResponse<T>(
      503,
      error instanceof Error ? error.message : "Service unavailable"
    );
  }
};

export const getServiceAccessToken = async (): Promise<string> => {
  const expiresAt = Number(
    (await TokenService.getToken(TOKEN_EXPIRES_KEY)) || "0"
  );
  let accessToken = await TokenService.getToken(ACCESS_TOKEN_KEY);
  if (
    (!accessToken || (expiresAt && expiresAt < Date.now() + 30_000)) &&
    (await refreshSession())
  ) {
    accessToken = await TokenService.getToken(ACCESS_TOKEN_KEY);
  }
  return accessToken || "";
};

export const serviceStream = async (
  path: string,
  body: any,
  onMessage: (data: string) => void
): Promise<ApiResponse<null>> => {
  const baseUrl = getServiceBaseUrl();
  const accessToken = await getServiceAccessToken();
  if (!baseUrl || !accessToken) {
    return emptyResponse<null>(401, "登录状态已失效，请重新登录");
  }
  const run = async (retry: boolean): Promise<ApiResponse<null>> => {
    try {
      const requestAccessToken = await getServiceAccessToken();
      const response = await fetch(baseUrl + path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          Authorization: `Bearer ${requestAccessToken}`,
        },
        body: JSON.stringify(body),
      });
      if (response.status === 401 && retry && (await refreshSession(true))) {
        return run(false);
      }
      if (!response.ok || !response.body) {
        if (response.status === 401) {
          const latestAccessToken = await TokenService.getToken(ACCESS_TOKEN_KEY);
          if (retry && latestAccessToken !== requestAccessToken) {
            return run(false);
          }
          if (!latestAccessToken || latestAccessToken === requestAccessToken) {
            await clearServiceSession();
          }
        }
        return emptyResponse<null>(response.status, response.statusText);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let doneReceived = false;
      const emitEvent = (event: string) => {
        for (const line of event.split(/\r?\n/)) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") {
            doneReceived = true;
            continue;
          }
          if (data) onMessage(data);
        }
      };
      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() || "";
        for (const event of events) {
          emitEvent(event);
        }
        if (doneReceived) {
          await reader.cancel();
          break;
        }
        if (done) {
          if (buffer.trim()) emitEvent(buffer);
          break;
        }
      }
      return { code: 200, msg: "success", data: null };
    } catch (error) {
      return emptyResponse<null>(
        503,
        error instanceof Error ? error.message : "Service unavailable"
      );
    }
  };
  return run(true);
};

export const getServiceHealth = async (
  force = false
): Promise<ApiResponse<ServiceHealth>> => {
  if (capabilityCache && !force) {
    return { code: 200, msg: "success", data: capabilityCache };
  }
  const response = await serviceRequest<ServiceHealth>("/v1/health", {
    method: "GET",
    authenticated: false,
  });
  if (response.code === 200 && response.data) {
    capabilityCache = {
      version: response.data.version || "",
      capabilities: response.data.capabilities || [],
    };
  }
  return response;
};

export const hasServiceCapability = async (
  capability: ServiceCapability
): Promise<boolean> => {
  const response = await getServiceHealth();
  return response.code === 200 && response.data.capabilities.includes(capability);
};

export const getAuthConfig = () =>
  serviceRequest<AuthConfig>("/v1/auth/config", {
    method: "GET",
    authenticated: false,
  });

export const registerServiceAccount = (config: {
  username: string;
  password: string;
  invite_code: string;
}) =>
  serviceRequest<null>("/v1/auth/register", {
    method: "POST",
    authenticated: false,
    body: JSON.stringify(config),
  });

export const loginServiceAccount = async (config: {
  username: string;
  password: string;
  device: object;
}): Promise<ApiResponse<ServiceUser>> => {
  const response = await serviceRequest<TokenPayload>("/v1/auth/login", {
    method: "POST",
    authenticated: false,
    body: JSON.stringify(config),
  });
  const user = normalizeUser(response.data?.user);
  if (response.code !== 200 || !response.data?.access_token || !user) {
    return emptyResponse<ServiceUser>(response.code, response.msg);
  }
  await saveSession(response.data);
  return { code: 200, msg: response.msg, data: user };
};

export const fetchServiceUser = async (): Promise<ApiResponse<ServiceUser>> => {
  const response = await serviceRequest<any>("/v1/auth/me", { method: "GET" });
  const user = normalizeUser(response.data);
  if (response.code !== 200 || !user) {
    return emptyResponse<ServiceUser>(response.code, response.msg);
  }
  await TokenService.setToken(USER_KEY, JSON.stringify(user));
  return { code: 200, msg: response.msg, data: user };
};

export const logoutServiceAccount = async () => {
  const baseUrl = getServiceBaseUrl();
  const accessToken = await TokenService.getToken(ACCESS_TOKEN_KEY);
  await clearServiceSession();
  resetServiceCache();
  if (baseUrl && accessToken) {
    void fetch(baseUrl + "/v1/auth/logout", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: "{}",
      keepalive: true,
    }).catch(() => undefined);
  }
};

export const getAdminConfig = () =>
  serviceRequest<AdminConfig>("/v1/admin/config", { method: "GET" });

export const updateAdminConfig = (config: {
  registration_mode: "admin" | "invite";
  service_name: string;
  koreader_registration_enabled: boolean;
}) =>
  serviceRequest<AdminConfig>("/v1/admin/config", {
    method: "PUT",
    body: JSON.stringify(config),
  });

export const createAdminInvites = (config: {
  count: number;
  expires_in_days: number;
}) =>
  serviceRequest<{ codes: string[]; expires_at: number }>(
    "/v1/admin/invites",
    {
      method: "POST",
      body: JSON.stringify(config),
    }
  );

export const getAdminInvites = () =>
  serviceRequest<AdminInvite[]>("/v1/admin/invites", { method: "GET" });

export const getAdminUsers = () =>
  serviceRequest<ServiceUser[]>("/v1/admin/users", { method: "GET" });

export const createAdminUser = (config: {
  username: string;
  password: string;
  display_name?: string;
}) =>
  serviceRequest<ServiceUser>("/v1/admin/users", {
    method: "POST",
    body: JSON.stringify(config),
  });
