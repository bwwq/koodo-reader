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
  normalizeServiceBaseUrl,
} = require("./service");

describe("online service isolation", () => {
  beforeEach(() => {
    Object.keys(mockConfigItems).forEach((key) => delete mockConfigItems[key]);
    Object.keys(mockReaderConfig).forEach((key) => delete mockReaderConfig[key]);
    Object.keys(mockTokens).forEach((key) => delete mockTokens[key]);
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
});
