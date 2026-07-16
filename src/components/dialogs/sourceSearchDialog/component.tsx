import React, { useEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import { ConfigService } from "../../../assets/lib/kookit-extra-browser.min";
import {
  BookImportJob,
  BookSourceItem,
  SourceSearchEvent,
  SourceSearchResult,
  cancelBookImport,
  createBookImport,
  deleteBookSource,
  downloadBookImport,
  importBookSourceContent,
  importBookSourceURL,
  importOPDSSource,
  listBookSources,
  searchBookSources,
  updateBookSource,
  watchBookImport,
} from "../../../utils/request/bookSources";
import "./sourceSearchDialog.css";
import { groupSourceResults, toggleSourceSelection } from "./sourceSearchUtils";

interface Props {
  handleSourceSearchDialog: (open: boolean) => void;
  handleSetting: (open: boolean) => void;
  handleSettingMode: (mode: string) => void;
  importBookFunc: (file: File) => Promise<void>;
  t: (key: string) => string;
}

const LAST_SELECTION_KEY = "source-search-selected-v1";

const stageLabels: Record<string, string> = {
  queued: "等待处理",
  preparing: "准备下载",
  book_info: "解析详情",
  chapters: "获取章节",
  downloading: "下载文件",
  packaging: "生成 EPUB",
  ready: "导入完成",
  failed: "任务失败",
  cancelled: "已取消",
};

function SourceSearchDialog(props: Props) {
  const [sources, setSources] = useState<BookSourceItem[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [keyword, setKeyword] = useState("");
  const [results, setResults] = useState<SourceSearchResult[]>([]);
  const [sourceStatus, setSourceStatus] = useState<Record<string, string>>({});
  const [searching, setSearching] = useState(false);
  const [page, setPage] = useState(1);
  const [sourceURL, setSourceURL] = useState("");
  const [showSources, setShowSources] = useState(true);
  const [job, setJob] = useState<BookImportJob | null>(null);
  const [loadingSources, setLoadingSources] = useState(true);
  const [sourceError, setSourceError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const refreshSources = async () => {
    setLoadingSources(true);
    try {
      const response = await listBookSources();
      if (response.code !== 200 || !response.data) {
        setSources([]);
        setSelected([]);
        setSourceError(
          response.code === 400
            ? "请先配置自托管服务地址。"
            : response.code === 401
            ? "请先登录自托管服务，书源和搜索任务会按账号保存。"
            : response.msg || "书源加载失败，请检查服务连接。"
        );
        return;
      }
      setSourceError("");
      setSources(response.data);
      const enabled = response.data.filter((item) => item.enabled).map((item) => item.id);
      let remembered: string[] = [];
      try {
        remembered = JSON.parse(localStorage.getItem(LAST_SELECTION_KEY) || "[]");
      } catch {}
      const available = remembered.filter((id) => enabled.includes(id));
      setSelected(available.length ? available : enabled);
    } finally {
      setLoadingSources(false);
    }
  };

  const migrateLocalOPDS = async () => {
    try {
      const catalogMap = ConfigService.getAllObjectConfig("opdsCatalogs") || {};
      const catalogList = ConfigService.getAllListConfig("opdsCatalogList") || [];
      for (const id of catalogList) {
        const catalog = catalogMap[id];
        if (!catalog?.url) continue;
        await importOPDSSource({
          name: catalog.title || catalog.url,
          url: catalog.url,
          username: catalog.username || "",
          password: catalog.password || "",
        });
      }
    } catch {}
  };

  useEffect(() => {
    migrateLocalOPDS().finally(refreshSources);
  }, []);

  useEffect(() => {
    localStorage.setItem(LAST_SELECTION_KEY, JSON.stringify(selected));
  }, [selected]);

  const groups = useMemo(() => groupSourceResults(results), [results]);

  const toggleSource = (id: string) => {
    setSelected((current) => toggleSourceSelection(current, id));
  };

  const runSearch = async (nextPage = 1) => {
    if (!keyword.trim()) return toast.error("请输入书名或作者");
    if (!selected.length) return toast.error("请至少选择一个书源");
    if (nextPage === 1) {
      setResults([]);
      setSourceStatus({});
    }
    setSearching(true);
    setPage(nextPage);
    const response = await searchBookSources(
      keyword.trim(),
      selected,
      nextPage,
      (event: SourceSearchEvent) => {
        if (event.type === "result" && event.result) {
          setResults((current) =>
            current.some((item) => item.id === event.result!.id)
              ? current
              : [...current, event.result!]
          );
        } else {
          const status =
            event.type === "source_started"
              ? "搜索中"
              : event.type === "source_error"
              ? event.message || "失败"
              : `完成${event.count ? ` · ${event.count}` : ""}`;
          setSourceStatus((current) => ({ ...current, [event.source_id]: status }));
        }
      }
    );
    setSearching(false);
    if (response.code !== 200) toast.error(response.msg || "搜索失败");
  };

  const startImport = async (result: SourceSearchResult) => {
    const response = await createBookImport(result.id);
    if ((response.code !== 202 && response.code !== 200) || !response.data) {
      toast.error(response.msg || "无法创建导入任务");
      return;
    }
    setJob(response.data);
    let finalJob = response.data;
    const watched = await watchBookImport(response.data.id, (nextJob) => {
      finalJob = nextJob;
      setJob(nextJob);
    });
    if (watched.code !== 200) {
      toast.error(watched.msg || "任务连接中断");
      return;
    }
    if (finalJob.status !== "ready") {
      if (finalJob.error) toast.error(finalJob.error);
      return;
    }
    const file = await downloadBookImport(response.data.id).catch((error) => {
      toast.error(`下载失败: ${error.message}`);
      return null;
    });
    if (!file) return;
    await props.importBookFunc(file);
    toast.success("图书已导入书架");
    setJob(null);
  };

  const importFile = async (file?: File) => {
    if (!file) return;
    if (!/\.(json|txt)$/i.test(file.name)) return toast.error("请选择 .json 或 .txt 书源文件");
    const response = await importBookSourceContent(await file.text());
    if (response.code !== 200) return toast.error(response.msg || "导入失败");
    toast.success(`已导入 ${response.data?.imported || 0} 个书源`);
    await refreshSources();
  };

  const importURL = async () => {
    if (!/^https?:\/\//i.test(sourceURL.trim())) return toast.error("请输入有效的 HTTP/HTTPS 地址");
    const response = await importBookSourceURL(sourceURL.trim());
    if (response.code !== 200) return toast.error(response.msg || "导入失败");
    setSourceURL("");
    toast.success(`已导入 ${response.data?.imported || 0} 个书源`);
    await refreshSources();
  };

  const setEnabled = async (source: BookSourceItem) => {
    const response = await updateBookSource(source.id, { enabled: !source.enabled });
    if (response.code !== 200) return toast.error(response.msg || "更新失败");
    await refreshSources();
  };

  const removeSource = async (source: BookSourceItem) => {
    if (!window.confirm(`删除书源“${source.name}”？`)) return;
    const response = await deleteBookSource(source.id);
    if (response.code !== 200) return toast.error(response.msg || "删除失败");
    await refreshSources();
  };

  const openOnlineServiceSettings = () => {
    props.handleSourceSearchDialog(false);
    props.handleSettingMode("account");
    props.handleSetting(true);
  };

  const close = () => {
    if (searching || (job && ["queued", "running"].includes(job.status))) {
      if (!window.confirm("搜索或导入仍在进行，确定关闭？")) return;
    }
    props.handleSourceSearchDialog(false);
  };

  return (
    <div className="source-search-dialog">
      <header>
        <button className="source-back" onClick={close} aria-label="关闭">×</button>
        <div>
          <h2>从源搜索</h2>
          <p>同时搜索 OPDS 与已导入的阅读书源</p>
        </div>
        <button className="source-manage" onClick={() => setShowSources(!showSources)}>
          {showSources ? "收起书源" : "选择书源"}
        </button>
      </header>

      <div className="source-search-toolbar">
        <input
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && !searching && runSearch(1)}
          placeholder="输入书名或作者"
          autoFocus
        />
        <button className="source-primary" disabled={searching || loadingSources || !!sourceError} onClick={() => runSearch(1)}>
          {searching ? "搜索中…" : "搜索"}
        </button>
      </div>

      <main>
        {showSources && (
          <aside className="source-picker">
            <div className="source-picker-title">
              <strong>书源</strong>
              <span>
                <button onClick={() => setSelected(sources.filter((item) => item.enabled).map((item) => item.id))}>全选</button>
                <button onClick={() => setSelected([])}>取消</button>
              </span>
            </div>
            <div className="source-list">
              {loadingSources && <div className="source-list-message">正在加载书源…</div>}
              {!loadingSources && sourceError && (
                <div className="source-list-message source-list-error">书源暂不可用</div>
              )}
              {!loadingSources && !sourceError && !sources.length && (
                <div className="source-list-message">暂无书源，请导入文件或远程 JSON。</div>
              )}
              {!loadingSources && !sourceError && sources.map((source) => (
                <div className={`source-row ${source.enabled ? "" : "disabled"}`} key={source.id}>
                  <label>
                    <input type="checkbox" checked={selected.includes(source.id)} disabled={!source.enabled} onChange={() => toggleSource(source.id)} />
                    <span><b>{source.name}</b><small>{source.type.toUpperCase()}{source.group ? ` · ${source.group}` : ""}</small></span>
                  </label>
                  <em className={sourceStatus[source.id]?.includes("失败") ? "error" : ""}>{sourceStatus[source.id] || ""}</em>
                  {!source.built_in && (
                    <span className="source-actions">
                      <button onClick={() => setEnabled(source)}>{source.enabled ? "停用" : "启用"}</button>
                      <button onClick={() => removeSource(source)}>删除</button>
                    </span>
                  )}
                </div>
              ))}
            </div>
            <div className="source-import">
              <input ref={fileRef} hidden type="file" accept=".json,.txt,application/json,text/plain" onChange={(event) => importFile(event.target.files?.[0])} />
              <button onClick={() => fileRef.current?.click()}>导入文件</button>
              <div><input value={sourceURL} onChange={(event) => setSourceURL(event.target.value)} placeholder="远程 JSON 地址" /><button onClick={importURL}>导入</button></div>
              <small>支持阅读/Legado 单个或数组 JSON；远程地址仅导入一次。</small>
            </div>
          </aside>
        )}

        <section className="source-results">
          {sourceError ? (
            <div className="source-empty source-auth-empty">
              <b>{sourceError.includes("登录") ? "请先登录自托管服务" : "书源暂不可用"}</b>
              <span>{sourceError}</span>
              <button onClick={openOnlineServiceSettings}>{sourceError.includes("登录") ? "去登录" : "去设置"}</button>
            </div>
          ) : (
            <>
              {!groups.length && !searching && <div className="source-empty"><b>搜索你的书源</b><span>同名同作者会自动合并，导入时仍可选择具体来源。</span></div>}
              {groups.map((group) => (
            <article className="source-result-card" key={group.key}>
              {group.variants[0].cover_url ? <img src={group.variants[0].cover_url} alt="" /> : <div className="source-cover-placeholder">书</div>}
              <div className="source-result-info">
                <h3>{group.title}</h3>
                <p className="source-authors">{group.authors.join("、") || "未知作者"}</p>
                <p className="source-summary">{group.variants[0].summary || "暂无简介"}</p>
                <div className="source-variants">
                  {group.variants.map((variant) => (
                    <button key={variant.id} onClick={() => startImport(variant)} disabled={!!job}>
                      <span>{variant.source_name}</span>
                      <small>{variant.latest_chapter || variant.format?.toUpperCase() || (variant.source_type === "legado" ? "生成 EPUB" : "下载")}</small>
                    </button>
                  ))}
                </div>
              </div>
            </article>
              ))}
              {!!groups.length && <button className="source-load-more" disabled={searching} onClick={() => runSearch(page + 1)}>加载更多</button>}
            </>
          )}
        </section>
      </main>

      {job && (
        <div className="source-job">
          <div><strong>{stageLabels[job.stage] || job.stage}</strong><span>{job.total ? `${job.current} / ${job.total}` : ""}</span></div>
          <progress max={job.total || 1} value={job.current || (job.status === "ready" ? 1 : 0)} />
          {job.error && <p>{job.error}</p>}
          {["queued", "running"].includes(job.status) && <button onClick={async () => { await cancelBookImport(job.id); setJob(null); }}>取消任务</button>}
          {["failed", "cancelled"].includes(job.status) && <button onClick={() => setJob(null)}>关闭</button>}
        </div>
      )}
    </div>
  );
}

export default SourceSearchDialog;
