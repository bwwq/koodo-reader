const mockConfigItems = {};
const mockReaderConfig = {};
const mockTokens = {};

jest.mock("../../assets/lib/kookit-extra-browser.min", () => ({
  ConfigService: {
    getItem: (key) => mockConfigItems[key] || "",
    setItem: (key, value) => {
      mockConfigItems[key] = value;
    },
    getReaderConfig: (key) => mockReaderConfig[key] || "",
    setReaderConfig: (key, value) => {
      mockReaderConfig[key] = value;
    },
  },
  TokenService: {
    getToken: async (key) => mockTokens[key] || "",
    setToken: async (key, value) => {
      mockTokens[key] = value;
    },
    deleteToken: async (key) => {
      delete mockTokens[key];
    },
  },
}));

const {
  bindSyncToCurrentUser,
  canUseBoundOnlineSync,
  logoutServiceAccount,
  serviceRequest,
  normalizeServiceBaseUrl,
} = require("./service");

describe("online service isolation", () => {
  beforeEach(() => {
    Object.keys(mockConfigItems).forEach((key) => delete mockConfigItems[key]);
    Object.keys(mockReaderConfig).forEach((key) => delete mockReaderConfig[key]);
    Object.keys(mockTokens).forEach((key) => delete mockTokens[key]);
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("normalizes HTTP service addresses and rejects other protocols", () => {
    expect(normalizeServiceBaseUrl("https://reader.example.com///")).toBe(
      "https://reader.example.com"
    );
    expect(() => normalizeServiceBaseUrl("ftp://reader.example.com")).toThrow();
  });

  it("binds shared reading data to both the account and service address", async () => {
    mockConfigItems.serviceBaseUrl = "https://one.example.com";
    mockTokens.service_user = JSON.stringify({
      id: "user-a",
      username: "alice",
    });

    await expect(bindSyncToCurrentUser()).resolves.toBe(true);
    expect(mockConfigItems.boundSyncUserId).toBe("user-a");
    expect(mockConfigItems.boundSyncServiceBaseUrl).toBe(
      "https://one.example.com"
    );
    await expect(canUseBoundOnlineSync()).resolves.toBe(true);
  });

  it("stops online sync after switching account or service", async () => {
    mockConfigItems.serviceBaseUrl = "https://one.example.com";
    mockConfigItems.boundSyncServiceBaseUrl = "https://one.example.com";
    mockConfigItems.boundSyncUserId = "user-a";
    mockReaderConfig.isEnableOnlineSync = "yes";
    mockTokens.service_user = JSON.stringify({ id: "user-b", username: "bob" });

    await expect(canUseBoundOnlineSync()).resolves.toBe(false);
    await expect(bindSyncToCurrentUser()).resolves.toBe(false);

    mockTokens.service_user = JSON.stringify({ id: "user-a", username: "alice" });
    mockConfigItems.serviceBaseUrl = "https://two.example.com";
    await expect(canUseBoundOnlineSync()).resolves.toBe(false);
    await expect(bindSyncToCurrentUser()).resolves.toBe(false);
  });

  it("restores an authenticated request when only the refresh token remains", async () => {
    mockConfigItems.serviceBaseUrl = "https://reader.example.com";
    mockTokens.service_refresh_token = "still-valid";
    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          code: 200,
          msg: "success",
          data: {
            access_token: "renewed-access",
            refresh_token: "renewed-refresh",
            expires_in: 900,
            user: { id: "user-a", username: "alice" },
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ code: 200, msg: "success", data: [] }),
      });

    await expect(
      serviceRequest("/v1/book-sources", { method: "GET" })
    ).resolves.toMatchObject({ code: 200, data: [] });
    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      "https://reader.example.com/v1/auth/refresh",
      expect.objectContaining({ method: "POST" })
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      "https://reader.example.com/v1/book-sources",
      expect.objectContaining({ method: "GET", headers: expect.anything() })
    );
    const requestHeaders = global.fetch.mock.calls[1][1].headers;
    expect(requestHeaders.get("Authorization")).toBe("Bearer renewed-access");
    expect(mockTokens.service_access_token).toBe("renewed-access");
  });

  it("does not clear a newer access token when an older request returns 401", async () => {
    mockConfigItems.serviceBaseUrl = "https://reader.example.com";
    mockTokens.service_access_token = "old-access";
    global.fetch
      .mockImplementationOnce(async () => {
        mockTokens.service_access_token = "new-access-from-another-tab";
        return {
          ok: false,
          status: 401,
          statusText: "Unauthorized",
          json: async () => ({ code: 401, msg: "expired" }),
        };
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ code: 200, msg: "success", data: [] }),
      });

    await expect(
      serviceRequest("/v1/book-sources", { method: "GET" })
    ).resolves.toMatchObject({ code: 200, data: [] });
    expect(mockTokens.service_access_token).toBe("new-access-from-another-tab");
    const retryHeaders = global.fetch.mock.calls[1][1].headers;
    expect(retryHeaders.get("Authorization")).toBe(
      "Bearer new-access-from-another-tab"
    );
  });

  it("logs out locally without waiting for an expired server session", async () => {
    mockConfigItems.serviceBaseUrl = "https://reader.example.com";
    mockTokens.service_access_token = "expired-access";
    mockTokens.service_refresh_token = "expired-refresh";
    mockTokens.service_token_expires_at = "1";
    mockTokens.service_user = JSON.stringify({ id: "user-a", username: "alice" });
    global.fetch.mockRejectedValueOnce(new Error("offline"));

    await logoutServiceAccount();

    expect(mockTokens.service_access_token).toBeUndefined();
    expect(mockTokens.service_refresh_token).toBeUndefined();
    expect(mockTokens.service_token_expires_at).toBeUndefined();
    expect(mockTokens.service_user).toBeUndefined();
    expect(global.fetch).toHaveBeenCalledWith(
      "https://reader.example.com/v1/auth/logout",
      expect.objectContaining({
        method: "POST",
        keepalive: true,
        headers: expect.objectContaining({
          Authorization: "Bearer expired-access",
        }),
      })
    );
  });
});
