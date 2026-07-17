import SyncService from "../storage/syncService";
import {
  ConfigService,
  CommonTool,
  SqlStatement,
} from "../../assets/lib/kookit-extra-browser.min";
import DatabaseService from "../storage/databaseService";
import SqlUtil from "./sqlUtil";
import { isElectron } from "react-device-detect";
import { getStorageLocation } from "../common";
import { getCloudConfig } from "./common";
import {
  getOnlineSyncItem,
  putOnlineSyncItems,
  SyncItem,
} from "../request/thirdparty";
import Note from "../../models/Note";

interface SyncEnvelope {
  schema: "dual-v1";
  version: number;
  updated_at: number;
  content: string;
}

const makeEnvelope = (content: string, version = Date.now()): SyncEnvelope => ({
  schema: "dual-v1",
  version,
  updated_at: version > 0 ? Date.now() : 0,
  content,
});

const normalizeTimestamp = (value: number | string | undefined): number => {
  if (value === undefined || value === null || value === "") return 0;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric > 0 && numeric < 1_000_000_000_000
      ? numeric * 1000
      : numeric;
  }
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
};

const parseEnvelope = (raw: string | undefined, fallback: string): SyncEnvelope => {
  if (!raw) return makeEnvelope(fallback, 0);
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.schema === "dual-v1" && typeof parsed.content === "string") {
      return parsed as SyncEnvelope;
    }
  } catch {
    // Legacy payloads are represented below with version zero.
  }
  return { schema: "dual-v1", version: 0, updated_at: 0, content: raw };
};

const fromOnlineItem = (
  item: SyncItem | undefined,
  fallback: string
): SyncEnvelope =>
  item
    ? {
        schema: "dual-v1",
        version: Number(item.version) || 0,
        updated_at: normalizeTimestamp(item.updated_at),
        content: item.content || fallback,
      }
    : makeEnvelope(fallback, 0);

const newest = (a: SyncEnvelope, b: SyncEnvelope): SyncEnvelope => {
  // Provider and online-service versions use independent counters. Their
  // timestamps are the only comparable freshness signal across both stores.
  if (a.updated_at !== b.updated_at) return a.updated_at > b.updated_at ? a : b;
  return a.version >= b.version ? a : b;
};

const ensureProviderWrite = (result: any) => {
  if (result === false || result?.success === false) {
    throw new Error("The selected data source rejected the upload");
  }
};

class ConfigUtil {
  public static syncData: any = {};
  public static updateData: any = {};
  public static updateVersions: Record<string, number> = {};
  public static onlineVersions: Record<string, number> = {};
  public static providerMirrorTypes = new Set<string>();
  public static providerWriteErrors: Error[] = [];
  static resetOnlineState() {
    this.syncData = {};
    this.updateData = {};
    this.updateVersions = {};
    this.onlineVersions = {};
    this.providerMirrorTypes.clear();
    this.providerWriteErrors = [];
  }
  private static recordProviderWriteError(error: unknown) {
    this.providerWriteErrors.push(
      error instanceof Error ? error : new Error(String(error))
    );
  }
  static async downloadConfig(type: string) {
    if (isElectron) {
      const { ipcRenderer } = window.require("electron");
      let service = ConfigService.getItem("defaultSyncOption");
      if (!service) {
        return;
      }
      let tokenConfig = await getCloudConfig(service);
      let result = await ipcRenderer.invoke("cloud-download", {
        ...tokenConfig,
        fileName: type + ".json",
        service: service,
        type: "config",
        storagePath: getStorageLocation(),
      });
      if (!result) {
        console.error("no config file");
        return undefined;
      }
      let fs = window.require("fs");
      if (!fs.existsSync(getStorageLocation() + "/config/" + type + ".json")) {
        return "{}";
      }
      let configStr = fs.readFileSync(
        getStorageLocation() + "/config/" + type + ".json",
        "utf-8"
      );
      return configStr;
    } else {
      let syncUtil = await SyncService.getSyncUtil();
      let jsonBuffer: ArrayBuffer = await syncUtil.downloadFile(
        type + ".json",
        "config"
      );
      if (!jsonBuffer) {
        return undefined;
      }
      let jsonStr = new TextDecoder().decode(jsonBuffer);
      return jsonStr;
    }
  }
  static async uploadConfig(type: string) {
    let config = {};
    if (type === "sync") {
      config = ConfigService.getAllSyncRecord();
    } else {
      let configList = CommonTool.configList;
      for (let i = 0; i < configList.length; i++) {
        let item = configList[i];
        if (ConfigService.getItem(item)) {
          config[item] = ConfigService.getItem(item);
        }
      }
    }
    const content = JSON.stringify(config);
    const version = Date.now();
    const envelope = makeEnvelope(content, version);
    this.updateData[type] = content;
    this.updateVersions[type] = this.onlineVersions[type] || 0;
    const service = ConfigService.getItem("defaultSyncOption");
    if (!service) return;
    try {
      if (isElectron) {
        const { ipcRenderer } = window.require("electron");
        let tokenConfig = await getCloudConfig(service);
        let fs = window.require("fs");
        if (!fs.existsSync(getStorageLocation() + "/config")) {
          fs.mkdirSync(getStorageLocation() + "/config", { recursive: true });
        }
        fs.writeFileSync(
          getStorageLocation() + "/config/" + type + ".json",
          JSON.stringify(envelope)
        );

        const result = await ipcRenderer.invoke("cloud-upload", {
          ...tokenConfig,
          fileName: type + ".json",
          service,
          type: "config",
          storagePath: getStorageLocation(),
        });
        ensureProviderWrite(result);
      } else {
        let syncUtil = await SyncService.getSyncUtil();
        let configBlob = new Blob([JSON.stringify(envelope)], {
          type: "application/json",
        });
        ensureProviderWrite(
          await syncUtil.uploadFile(type + ".json", "config", configBlob)
        );
      }
    } catch (error) {
      this.recordProviderWriteError(error);
    }
  }
  static async getSyncData(type: string) {
    let defaultValue = type === "sync" || type === "config" ? "{}" : "[]";
    if (this.syncData[type]) {
      return JSON.parse(this.syncData[type] || defaultValue);
    }
    const response = await getOnlineSyncItem(type);
    if (response.code === 200) {
      this.onlineVersions[type] = Number(response.data.version) || 0;
      this.syncData[type] = response.data.content;
      return JSON.parse(this.syncData[type] || defaultValue);
    }
    this.onlineVersions[type] = 0;
    return null;
  }
  static async updateSyncData() {
    let onlineSaved = false;
    for (const type of Array.from(this.providerMirrorTypes)) {
      if (type === "sync" || type === "config") {
        await this.uploadConfig(type);
      } else {
        await this.uploadDatabase(type);
      }
      this.providerMirrorTypes.delete(type);
    }
    if (Object.keys(this.updateData).length > 0) {
      // Some upload-only sync tasks do not read the corresponding remote item
      // first. Resolve that missing baseline immediately before the optimistic
      // write so an existing item is not mistaken for a concurrent change.
      for (const type of Object.keys(this.updateData)) {
        if (!Object.prototype.hasOwnProperty.call(this.onlineVersions, type)) {
          const current = await getOnlineSyncItem(type);
          const version =
            current.code === 200 && current.data
              ? Number(current.data.version) || 0
              : 0;
          this.onlineVersions[type] = version;
          this.updateVersions[type] = version;
        }
      }
      const response = await putOnlineSyncItems(
        this.updateData,
        this.updateVersions
      );
      if (response.code === 409) {
        this.syncData = {};
        throw new Error("Online sync version conflict");
      }
      if (response.code !== 200 && response.code !== 410) {
        throw new Error(response.msg || "Online sync failed");
      }
      if (response.code === 200) {
        onlineSaved = true;
        Object.keys(this.updateData).forEach((type) => {
          const savedItem = response.data?.[type];
          this.onlineVersions[type] = savedItem
            ? Number(savedItem.version) || 0
            : (this.onlineVersions[type] || 0) + 1;
        });
      }
    }
    const providerErrors = [...this.providerWriteErrors];
    this.syncData = {};
    this.updateData = {};
    this.updateVersions = {};
    this.providerWriteErrors = [];
    if (providerErrors.length > 0) {
      throw new Error(
        (onlineSaved
          ? "Online service was saved, but the selected data source could not be updated: "
          : "The selected data source could not be updated: ") +
          providerErrors[0].message
      );
    }
  }
  static async getCloudConfig(type: string) {
    const [providerRaw, online] = await Promise.all([
      ConfigUtil.downloadConfig(type).catch(() => undefined),
      getOnlineSyncItem(type),
    ]);
    const providerAvailable = typeof providerRaw === "string";
    const provider = parseEnvelope(providerRaw, "{}");
    const service = fromOnlineItem(
      online.code === 200 ? online.data : undefined,
      "{}"
    );
    this.onlineVersions[type] =
      online.code === 200 ? Number(online.data.version) || 0 : 0;
    const selected = newest(provider, service);
    if (provider.updated_at > service.updated_at) {
      this.updateData[type] = provider.content;
      this.updateVersions[type] = this.onlineVersions[type];
    } else if (
      service.updated_at > provider.updated_at &&
      providerAvailable &&
      ConfigService.getItem("defaultSyncOption")
    ) {
      this.providerMirrorTypes.add(type);
    }
    this.syncData[type] = selected.content;
    try {
      return JSON.parse(selected.content || "{}");
    } catch {
      return {};
    }
  }

  static async getCloudDatabase(database: string) {
    const loadProvider = async (): Promise<SyncEnvelope | null> => {
      const service = ConfigService.getItem("defaultSyncOption");
      if (!service) return makeEnvelope("[]", 0);
      if (isElectron) {
        const { ipcRenderer } = window.require("electron");
        const tokenConfig = await getCloudConfig(service);
        const result = await ipcRenderer.invoke("cloud-download", {
          ...tokenConfig,
          fileName: database + ".db",
          service,
          type: "config",
          isTemp: true,
          storagePath: getStorageLocation(),
        });
        if (!result) return null;
        const records = await DatabaseService.getAllRecords("temp-" + database);
        await ipcRenderer.invoke("close-database", {
          dbName: "temp-" + database,
          storagePath: getStorageLocation(),
        });
        let meta: any = {};
        const metaResult = await ipcRenderer.invoke("cloud-download", {
          ...tokenConfig,
          fileName: database + ".meta.json",
          service,
          type: "config",
          storagePath: getStorageLocation(),
        });
        if (metaResult) {
          try {
            const fs = window.require("fs");
            meta = JSON.parse(
              fs.readFileSync(
                getStorageLocation() + "/config/" + database + ".meta.json",
                "utf-8"
              )
            );
          } catch {
            meta = {};
          }
        }
        return {
          schema: "dual-v1",
          version: Number(meta.version) || 0,
          updated_at: Number(meta.updated_at) || 0,
          content: JSON.stringify(records),
        };
      }
      const syncUtil = await SyncService.getSyncUtil();
      const [dbBuffer, metaBuffer] = await Promise.all([
        syncUtil.downloadFile(database + ".db", "config"),
        syncUtil.downloadFile(database + ".meta.json", "config"),
      ]);
      if (!dbBuffer) return null;
      const records = await new SqlUtil().dbBufferToJson(dbBuffer, database);
      let meta: any = {};
      try {
        meta = metaBuffer
          ? JSON.parse(new TextDecoder().decode(metaBuffer))
          : {};
      } catch {
        meta = {};
      }
      return {
        schema: "dual-v1",
        version: Number(meta.version) || 0,
        updated_at: Number(meta.updated_at) || 0,
        content: JSON.stringify(records),
      };
    };
    const [provider, online] = await Promise.all([
      loadProvider().catch(() => null),
      getOnlineSyncItem(database),
    ]);
    this.onlineVersions[database] =
      online.code === 200 ? Number(online.data.version) || 0 : 0;
    const selected = newest(
      provider || makeEnvelope("[]", 0),
      fromOnlineItem(online.code === 200 ? online.data : undefined, "[]")
    );
    const service = fromOnlineItem(
      online.code === 200 ? online.data : undefined,
      "[]"
    );
    if (provider && provider.updated_at > service.updated_at) {
      this.updateData[database] = provider.content;
      this.updateVersions[database] = this.onlineVersions[database];
    } else if (
      provider !== null &&
      service.updated_at > provider.updated_at &&
      ConfigService.getItem("defaultSyncOption")
    ) {
      this.providerMirrorTypes.add(database);
    }
    this.syncData[database] = selected.content;
    try {
      return JSON.parse(selected.content || "[]");
    } catch {
      return [];
    }
  }
  static async uploadDatabase(type: string) {
    let data = await DatabaseService.getAllRecords(type);
    if (type === "books") {
      data = data.map((record) => ({ ...record, cover: "" }));
    }
    const version = Date.now();
    this.updateData[type] = JSON.stringify(data);
    this.updateVersions[type] = this.onlineVersions[type] || 0;
    const meta = { schema: "dual-v1", version, updated_at: Date.now() };
    const service = ConfigService.getItem("defaultSyncOption");
    if (!service) return;
    try {
      if (isElectron) {
        const { ipcRenderer } = window.require("electron");
        await ipcRenderer.invoke("close-database", {
          dbName: type,
          storagePath: getStorageLocation(),
        });
        let tokenConfig = await getCloudConfig(service);
        const fs = window.require("fs");
        const configPath = getStorageLocation() + "/config";
        if (!fs.existsSync(configPath)) {
          fs.mkdirSync(configPath, { recursive: true });
        }
        fs.writeFileSync(
          configPath + "/" + type + ".meta.json",
          JSON.stringify(meta)
        );
        const dbResult = await ipcRenderer.invoke("cloud-upload", {
          ...tokenConfig,
          fileName: type + ".db",
          service,
          type: "config",
          storagePath: getStorageLocation(),
        });
        ensureProviderWrite(dbResult);
        const metaResult = await ipcRenderer.invoke("cloud-upload", {
          ...tokenConfig,
          fileName: type + ".meta.json",
          service,
          type: "config",
          storagePath: getStorageLocation(),
        });
        ensureProviderWrite(metaResult);
      } else {
        let dbBuffer = await DatabaseService.getDbBuffer(type);
        let dbBlob = new Blob([dbBuffer], {
          type: CommonTool.getMimeType("db"),
        });
        let syncUtil = await SyncService.getSyncUtil();
        ensureProviderWrite(
          await syncUtil.uploadFile(type + ".db", "config", dbBlob)
        );
        ensureProviderWrite(
          await syncUtil.uploadFile(
            type + ".meta.json",
            "config",
            new Blob([JSON.stringify(meta)], { type: "application/json" })
          )
        );
      }
    } catch (error) {
      this.recordProviderWriteError(error);
    }
  }
  static async getNotesByBookKeyAndTypeWithSort(
    bookKey: string,
    type: string,
    sort: string = "key",
    order: string = "DESC"
  ) {
    if (isElectron) {
      let queryString = "";
      let data: any[] = [];
      if (type === "note" && bookKey) {
        queryString = `SELECT key, bookKey, chapterIndex FROM notes WHERE bookKey = ? AND notes != '' AND notes != 'annotation' ORDER BY ${sort} ${order}`;
        data = [bookKey];
      } else if (type === "highlight" && bookKey) {
        queryString = `SELECT key, bookKey, chapterIndex FROM notes WHERE bookKey = ? AND notes = '' ORDER BY ${sort} ${order}`;
        data = [bookKey];
      } else if (type === "note" && !bookKey) {
        queryString = `SELECT key, bookKey, chapterIndex FROM notes WHERE notes != '' AND notes != 'annotation' ORDER BY ${sort} ${order}`;
      } else if (type === "highlight" && !bookKey) {
        queryString = `SELECT key, bookKey, chapterIndex FROM notes WHERE notes = '' ORDER BY ${sort} ${order}`;
      } else if (type === "annotation" && bookKey) {
        queryString = `SELECT key, bookKey, chapterIndex FROM notes WHERE bookKey = ? AND notes = 'annotation' ORDER BY ${sort} ${order}`;
        data = [bookKey];
      } else if (type === "annotation" && !bookKey) {
        queryString = `SELECT key, bookKey, chapterIndex FROM notes WHERE notes = 'annotation' ORDER BY ${sort} ${order}`;
      } else if (!type && bookKey) {
        queryString = `SELECT key, bookKey, chapterIndex FROM notes WHERE bookKey = ? ORDER BY ${sort} ${order}`;
        data = [bookKey];
      } else {
        queryString = `SELECT key, bookKey, chapterIndex FROM notes ORDER BY ${sort} ${order}`;
      }
      const { ipcRenderer } = window.require("electron");
      return await ipcRenderer.invoke("custom-database-command", {
        dbName: "notes",
        storagePath: getStorageLocation(),
        query: queryString,
        data: data,
        executeType: "all",
      });
    } else {
      let notes: Note[] = await DatabaseService.getAllRecords("notes");
      let filteredNotes = notes.filter((note) => {
        let typeMatch =
          (type === "note" &&
            note.notes !== "" &&
            note.notes !== "annotation") ||
          (type === "highlight" && note.notes === "") ||
          (type === "annotation" && note.notes === "annotation") ||
          !type;
        let bookKeyMatch = bookKey ? note.bookKey === bookKey : true;
        return typeMatch && bookKeyMatch;
      });
      if (sort === "key") {
        filteredNotes.sort((a, b) => {
          if (order === "ASC") {
            return Number(a.key) - Number(b.key);
          } else {
            return Number(b.key) - Number(a.key);
          }
        });
      } else if (sort === "percentage") {
        filteredNotes.sort((a, b) => {
          if (order === "ASC") {
            return Number(a.percentage) - Number(b.percentage);
          } else {
            return Number(b.percentage) - Number(a.percentage);
          }
        });
      }
      return filteredNotes;
    }
  }
  static async searchNotesByKeyword(
    keyword: string,
    bookKey: string,
    type: string
  ) {
    if (isElectron) {
      const { ipcRenderer } = window.require("electron");
      let queryString = "";
      let data: any[] = [];
      if (type === "note" && bookKey) {
        queryString = `SELECT * FROM notes WHERE bookKey = ? AND notes != '' AND notes != 'annotation' AND (notes LIKE ? OR text LIKE ?) ORDER BY key DESC`;
        data = [
          bookKey,
          `%${keyword.toLowerCase()}%`,
          `%${keyword.toLowerCase()}%`,
        ];
      } else if (type === "highlight" && bookKey) {
        queryString = `SELECT * FROM notes WHERE bookKey = ? AND (notes = '' AND (notes LIKE ? OR text LIKE ?)) ORDER BY key DESC`;
        data = [
          bookKey,
          `%${keyword.toLowerCase()}%`,
          `%${keyword.toLowerCase()}%`,
        ];
      } else if (type === "note" && !bookKey) {
        queryString = `SELECT * FROM notes WHERE (notes != '' AND notes != 'annotation' AND (notes LIKE ? OR text LIKE ?)) ORDER BY key DESC`;
        data = [`%${keyword.toLowerCase()}%`, `%${keyword.toLowerCase()}%`];
      } else if (type === "highlight" && !bookKey) {
        queryString = `SELECT * FROM notes WHERE (notes = '' AND (notes LIKE ? OR text LIKE ?)) ORDER BY key DESC`;
        data = [`%${keyword.toLowerCase()}%`, `%${keyword.toLowerCase()}%`];
      } else if (!type && bookKey) {
        queryString = `SELECT * FROM notes WHERE bookKey = ? AND (notes LIKE ? OR text LIKE ?) ORDER BY key DESC`;
        data = [
          bookKey,
          `%${keyword.toLowerCase()}%`,
          `%${keyword.toLowerCase()}%`,
        ];
      } else {
        queryString = `SELECT * FROM notes WHERE (notes LIKE ? OR text LIKE ?) ORDER BY key DESC`;
        data = [`%${keyword.toLowerCase()}%`, `%${keyword.toLowerCase()}%`];
      }
      return await ipcRenderer.invoke("custom-database-command", {
        dbName: "notes",
        storagePath: getStorageLocation(),
        query: queryString,
        data: data,
        executeType: "all",
      });
    } else {
      let notes = await DatabaseService.getAllRecords("notes");
      let filteredNotes = notes.filter(
        (note) =>
          ((type === "note" &&
            note.notes !== "" &&
            note.notes !== "annotation") ||
            (type === "highlight" && note.notes === "") ||
            !type) &&
          (note.bookKey === bookKey || !bookKey) &&
          (note.notes.toLowerCase().includes(keyword.toLowerCase()) ||
            note.text.toLowerCase().includes(keyword.toLowerCase()))
      );
      filteredNotes.sort((a, b) => b.key - a.key);
      return filteredNotes;
    }
  }
  static async searchBookmarksByKeyword(keyword: string, bookKey: string) {
    if (isElectron) {
      const { ipcRenderer } = window.require("electron");
      let queryString = "";
      let data: any[] = [];
      if (bookKey) {
        queryString = `SELECT * FROM bookmarks WHERE bookKey = ? AND (label LIKE ? OR chapter LIKE ?) ORDER BY key DESC`;
        data = [
          bookKey,
          `%${keyword.toLowerCase()}%`,
          `%${keyword.toLowerCase()}%`,
        ];
      } else {
        queryString = `SELECT * FROM bookmarks WHERE (label LIKE ? OR chapter LIKE ?) ORDER BY key DESC`;
        data = [`%${keyword.toLowerCase()}%`, `%${keyword.toLowerCase()}%`];
      }
      return await ipcRenderer.invoke("custom-database-command", {
        dbName: "bookmarks",
        storagePath: getStorageLocation(),
        query: queryString,
        data: data,
        executeType: "all",
      });
    } else {
      let bookmarks = await DatabaseService.getAllRecords("bookmarks");
      let filteredBookmarks = bookmarks.filter(
        (bookmark) =>
          (bookmark.bookKey === bookKey || !bookKey) &&
          (bookmark.label.toLowerCase().includes(keyword.toLowerCase()) ||
            bookmark.chapter.toLowerCase().includes(keyword.toLowerCase()))
      );
      filteredBookmarks.sort((a, b) => b.key - a.key);
      return filteredBookmarks;
    }
  }
  static async getNoteWithTags(tags: string[]) {
    if (isElectron) {
      const { ipcRenderer } = window.require("electron");
      let queryString = "";
      let data: any[] = [];
      if (tags.length > 0) {
        let instrArr = tags.map(() => "instr(tag, ?) > 0").join(" AND ");
        queryString = `SELECT * FROM notes WHERE ${instrArr} ORDER BY key DESC`;
        data = tags;
      } else {
        queryString = `SELECT * FROM notes ORDER BY key DESC`;
      }
      return await ipcRenderer.invoke("custom-database-command", {
        dbName: "notes",
        storagePath: getStorageLocation(),
        query: queryString,
        data: data,
        executeType: "all",
      });
    } else {
      let notes = await DatabaseService.getAllRecords("notes");
      let filteredNotes = notes.filter((note) => {
        for (let i = 0; i < tags.length; i++) {
          if (!note.tag.includes(tags[i])) {
            return false;
          }
        }
        return true;
      });
      filteredNotes.sort((a, b) => b.key - a.key);
      return filteredNotes;
    }
  }
  static async deleteTagFromNotes(tagName: string) {
    if (isElectron) {
      const { ipcRenderer } = window.require("electron");
      let rawNotes: any[] = await ipcRenderer.invoke(
        "custom-database-command",
        {
          dbName: "notes",
          storagePath: getStorageLocation(),
          query: `SELECT * FROM notes WHERE instr(tag, ?) > 0`,
          data: [tagName],
          executeType: "all",
        }
      );
      let notes = rawNotes.map((item) =>
        SqlStatement.sqliteToJson["notes"](item)
      );
      let updatedNotes = notes.map((item) => {
        return {
          ...item,
          tag: item.tag.filter((subitem: string) => subitem !== tagName),
        };
      });
      for (let i = 0; i < updatedNotes.length; i++) {
        await ipcRenderer.invoke("custom-database-command", {
          dbName: "notes",
          storagePath: getStorageLocation(),
          query: `UPDATE notes SET tag = ? WHERE key = ?`,
          data: [JSON.stringify(updatedNotes[i].tag), updatedNotes[i].key],
          executeType: "run",
        });
      }
    } else {
      let notes: any[] = await DatabaseService.getAllRecords("notes");
      let filteredNotes = notes.filter((note) => note.tag.includes(tagName));
      let updatedNotes = filteredNotes.map((item) => {
        return {
          ...item,
          tag: item.tag.filter((subitem) => subitem !== tagName),
        };
      });
      for (let i = 0; i < updatedNotes.length; i++) {
        await DatabaseService.updateRecord(updatedNotes[i], "notes");
      }
    }
  }
  static async getNoteList() {
    if (isElectron) {
      const { ipcRenderer } = window.require("electron");
      let queryString = `SELECT key, bookKey, chapterIndex FROM notes ORDER BY key DESC`;
      return await ipcRenderer.invoke("custom-database-command", {
        dbName: "notes",
        storagePath: getStorageLocation(),
        query: queryString,
        executeType: "all",
      });
    } else {
      let notes = await DatabaseService.getAllRecords("notes");
      notes.sort((a, b) => b.key - a.key);
      return notes;
    }
  }
  static async dumpConfig(type: string) {
    let config = {};
    if (type === "sync") {
      config = ConfigService.getAllSyncRecord();
    } else {
      let configList = CommonTool.configList;
      configList = [
        ...configList,
        "dictList",
        "backgroundList",
        "fontList",
        "readerConfig",
        "customBackgrounds",
        "customFonts",
        "customDicts",
      ];
      for (let i = 0; i < configList.length; i++) {
        let item = configList[i];
        if (ConfigService.getItem(item)) {
          config[item] = ConfigService.getItem(item);
        }
      }
    }
    return config;
  }
  static clearConfig(type: string) {
    if (type === "sync") {
      ConfigService.removeItem("syncRecord");
    } else {
      let configList = CommonTool.configList;
      for (let i = 0; i < configList.length; i++) {
        let item = configList[i];
        ConfigService.removeItem(item);
      }
    }
  }
  static async loadConfig(type: string, configStr: string) {
    let tempConfig = JSON.parse(configStr);
    if (type === "sync") {
      ConfigService.setAllSyncRecord(tempConfig);
    } else {
      for (let key in tempConfig) {
        ConfigService.setItem(key, tempConfig[key]);
      }
    }
  }
  static async isCloudEmpty() {
    const syncData = await this.getCloudConfig("sync");
    if (!syncData || Object.keys(syncData).length === 0) {
      return true;
    }
    return false;
  }
}
export default ConfigUtil;
