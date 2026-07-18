import React, { useEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import { ConfigService } from "../../../assets/lib/kookit-extra-browser.min";
import {
  BookImportJob,
  BookBrowserSession,
  BookSourceAction,
  BookSourceProfile,
  BookSourceItem,
  ImportBookFunction,
  SourceSearchEvent,
  SourceSearchResult,
  cancelBookImport,
  cancelBookBrowserSession,
  claimBookImport,
  createBookImport,
  deleteBookSource,
  downloadBookImport,
  getBookImportFormat,
  getBookBrowserWebSocketURL,
  getBookSourceProfile,
  importBookSourceContent,
  importBookSourceURL,
  importOPDSSource,
  listBookSources,
  listBookBrowserSessions,
  markBookImportCompleted,
  searchBookSources,
  runBookSourceAction,
  watchBookSourceAction,
  clearBookSourceSession,
  createBookBrowserTicket,
  finishBookBrowserSession,
  updateBookSource,
  watchBookImport,
} from "../../../utils/request/bookSources";
import "./sourceSearchDialog.css";
import { groupSourceResults, toggleSourceSelection } from "./sourceSearchUtils";

interface Props {
  handleSourceSearchDialog: (open: boolean) => void;
  handleSetting: (open: boolean) => void;
  handleSettingMode: (mode: string) => void;
  importBookFunc: ImportBookFunction;
  t: (key: string) => string;
}

const LAST_SELECTION_KEY = "source-search-selected-v2";

const stageLabels: Record<string, string> = {
  queued: "等待处理",
  preparing: "准备下载",
  book_info: "解析详情",
  chapters: "获取章节",
  images: "下载并处理图片",
  waiting_user: "等待完成网页操作",
  downloading: "下载文件",
  packaging: "生成 EPUB",
  preprocessing: "优化打开速度",
  ready: "导入完成",
  failed: "任务失败",
  cancelled: "已取消",
};

const sourceTypeLabels: Record<string, string> = {
  opds: "OPDS",
  legado: "阅读书源",
  sonovel: "中文聚合",
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
  const [profileSource, setProfileSource] = useState<BookSourceItem | null>(null);
  const [profile, setProfile] = useState<BookSourceProfile | null>(null);
  const [sourceAction, setSourceAction] = useState<BookSourceAction | null>(null);
  const [browserSession, setBrowserSession] = useState<BookBrowserSession | null>(null);
  const [browserFrame, setBrowserFrame] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const profileFormRef = useRef<HTMLFormElement>(null);
  const browserTextRef = useRef<HTMLInputElement>(null);
  const browserSocketRef = useRef<WebSocket | null>(null);

  const refreshSources = async () => {
    setLoadingSources(true);
    try {
      const response = await listBookSources();
      if (response.code !== 200 || !response.data) {
        setSources([]);
        setSelected([]);
        setSourceError(
          response.code === 400
            ? "尚未配置在线服务地址。"
            : response.code === 401
            ? "当前账号的登录状态已失效，请重新登录。"
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

  useEffect(() => () => {
    browserSocketRef.current?.close();
  }, []);

  const connectBrowser = async (session: BookBrowserSession) => {
    if (browserSession?.id === session.id && browserSocketRef.current) return;
    const ticket = await createBookBrowserTicket(session.id);
    if (ticket.code !== 200 || !ticket.data) return toast.error(ticket.msg || "无法打开网页操作");
    browserSocketRef.current?.close();
    setBrowserSession(session);
    const socket = new WebSocket(getBookBrowserWebSocketURL(session.id, ticket.data.ticket));
    socket.binaryType = "blob";
    socket.onmessage = (event) => {
      if (!(event.data instanceof Blob)) return;
      setBrowserFrame((previous) => {
        if (previous) URL.revokeObjectURL(previous);
        return URL.createObjectURL(event.data);
      });
    };
    socket.onerror = () => toast.error("网页画面连接中断");
    browserSocketRef.current = socket;
  };

  useEffect(() => {
    const active = searching || !!sourceAction && ["queued", "running"].includes(sourceAction.status) || !!job && ["queued", "running", "waiting_user"].includes(job.status);
    if (!active) return;
    const poll = async () => {
      const response = await listBookBrowserSessions();
      const session = response.data?.find((item) => item.state === "active");
      if (session && session.id !== browserSession?.id) await connectBrowser(session);
    };
    poll();
    const timer = window.setInterval(poll, 1000);
    return () => window.clearInterval(timer);
  }, [searching, sourceAction?.status, job?.status, browserSession?.id]);

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
    if (result.media_type === "unsupported") {
      return toast.error("当前版本暂不支持听书、短剧或视频离线导入");
    }
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
    let importedBookKey = "";
    await props.importBookFunc(file, {
      sourceSubscriptionId: finalJob.subscription_id,
      forcePrecache: true,
      onPrecacheStatus: (status) => {
        setJob({
          ...finalJob,
          status: status === "started" ? "running" : "ready",
          stage: "preprocessing",
          current: status === "started" ? 0 : 1,
          total: 1,
          error:
            status === "failed" ? "打开优化失败，下次进入书架时会自动重试" : undefined,
        });
      },
      onImported: (bookKey) => {
        importedBookKey = bookKey;
      },
    });
    if (!importedBookKey) {
      toast.error("图书文件已生成，但加入书架失败；返回书架后会自动重试");
      return;
    }
    const claimed = await claimBookImport(
      finalJob.id,
      importedBookKey,
      getBookImportFormat(file)
    );
    if (claimed.code !== 200) {
      toast.error(claimed.msg || "图书已加入书架，但服务端保存失败；稍后会自动重试");
      return;
    }
    markBookImportCompleted(finalJob.id);
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

  const openSourceProfile = async (source: BookSourceItem) => {
    const response = await getBookSourceProfile(source.id);
    if (response.code !== 200 || !response.data) return toast.error(response.msg || "读取书源设置失败");
    setProfileSource(source);
    setProfile(response.data);
    setSourceAction(null);
  };

  const runSourceAction = async (actionId: string) => {
    if (!profileSource || !profile || !profileFormRef.current) return;
    const values: Record<string, string | boolean> = {};
    const data = new FormData(profileFormRef.current);
    profile.fields.forEach((field) => {
      if (field.type === "button") return;
      values[field.name] = field.type === "checkbox" ? data.has(field.name) : String(data.get(field.name) || "");
    });
    const response = await runBookSourceAction(profileSource.id, actionId, values);
    profileFormRef.current.querySelectorAll<HTMLInputElement>('input[type="password"]').forEach((input) => { input.value = ""; });
    if (response.code !== 202 || !response.data) return toast.error(response.msg || "操作启动失败");
    setSourceAction(response.data);
    let finalAction = response.data;
    const watched = await watchBookSourceAction(response.data.id, (next) => {
      finalAction = next;
      setSourceAction(next);
    });
    if (watched.code !== 200) return toast.error(watched.msg || "操作连接中断");
    if (finalAction.status === "ready") {
      toast.success(finalAction.message || "操作已完成");
      await refreshSources();
      const refreshed = await getBookSourceProfile(profileSource.id);
      if (refreshed.code === 200 && refreshed.data) setProfile(refreshed.data);
    } else toast.error(finalAction.error || "操作失败");
  };

  const clearSourceLogin = async () => {
    if (!profileSource) return;
    const response = await clearBookSourceSession(profileSource.id);
    if (response.code !== 200) return toast.error(response.msg || "清除失败");
    toast.success("登录状态已清除");
    setProfileSource(null);
    setProfile(null);
    await refreshSources();
  };

  const sendBrowserEvent = (event: object) => {
    const socket = browserSocketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
  };

  const closeBrowser = async (finish: boolean) => {
    if (!browserSession) return;
    if (finish) await finishBookBrowserSession(browserSession.id);
    else await cancelBookBrowserSession(browserSession.id);
    browserSocketRef.current?.close();
    browserSocketRef.current = null;
    setBrowserSession(null);
    setBrowserFrame((previous) => { if (previous) URL.revokeObjectURL(previous); return ""; });
  };

  const openOnlineServiceSettings = () => {
    props.handleSourceSearchDialog(false);
    props.handleSettingMode("account");
    props.handleSetting(true);
  };

  const close = () => {
    if (searching || (job && ["queued", "running", "waiting_user"].includes(job.status))) {
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
                    <span><b>{source.name}</b><small>{sourceTypeLabels[source.type] || source.type}{source.group ? ` · ${source.group}` : ""}{source.shared ? " · 服务器共享" : ""}</small></span>
                  </label>
                  <em className={sourceStatus[source.id]?.includes("失败") ? "error" : ""}>{sourceStatus[source.id] || ""}</em>
                  {source.compatibility && (
                    <small className={`source-compatibility ${source.compatibility.status}`} title={(source.compatibility.reasons || []).join("\n")}>
                      {source.compatibility.status === "compatible" ? "兼容" : source.compatibility.status === "partial" ? "部分兼容" : "不兼容"}
                    </small>
                  )}
                  {!source.built_in && (
                    <span className="source-actions">
                      {(source.features?.includes("login") || source.features?.includes("webview")) && <button onClick={() => openSourceProfile(source)}>登录/设置</button>}
                      {!source.shared && <button onClick={() => setEnabled(source)}>{source.enabled ? "停用" : "启用"}</button>}
                      {!source.shared && <button onClick={() => removeSource(source)}>删除</button>}
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
              <b>{sourceError.includes("登录") ? "需要重新登录" : "书源暂不可用"}</b>
              <span>{sourceError}</span>
              <button onClick={openOnlineServiceSettings}>{sourceError.includes("登录") ? "重新登录" : "去设置"}</button>
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
                    <button key={variant.id} onClick={() => startImport(variant)} disabled={!!job || variant.media_type === "unsupported"}>
                      <span>{variant.source_name}</span>
                      <small>{variant.media_type === "comic" ? "漫画 EPUB" : variant.media_type === "unsupported" ? "暂不支持此媒体" : variant.latest_chapter || variant.format?.toUpperCase() || (variant.source_type === "opds" ? "下载" : "生成 EPUB")}</small>
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
          {job.message && <p>{job.message}</p>}
          {job.error && <p>{job.error}</p>}
          {["queued", "running", "waiting_user"].includes(job.status) && <button onClick={async () => { await cancelBookImport(job.id); setJob(null); }}>取消任务</button>}
          {["failed", "cancelled"].includes(job.status) && <button onClick={() => setJob(null)}>关闭</button>}
        </div>
      )}

      {profileSource && profile && (
        <div className="source-profile-backdrop">
          <section className="source-profile-panel">
            <header><h3>{profileSource.name}</h3><button aria-label="关闭" onClick={() => { setProfileSource(null); setProfile(null); }}>×</button></header>
            <form ref={profileFormRef} autoComplete="off">
              {profile.fields.map((field, index) => {
                const key = `${field.name}-${index}`;
                if (field.type === "button") return <button className="source-profile-action" type="button" key={key} disabled={!field.action_id || !!sourceAction && ["queued", "running"].includes(sourceAction.status)} onClick={() => field.action_id && runSourceAction(field.action_id)}>{field.name}</button>;
                if (field.type === "select") return <label key={key}><span>{field.name}</span><select name={field.name} defaultValue={String(field.value || "")}>{(field.options || []).map((option) => { const value = typeof option === "string" ? option : option.value; const label = typeof option === "string" ? option : option.label; return <option value={value} key={value}>{label}</option>; })}</select></label>;
                if (field.type === "checkbox") return <label className="source-profile-check" key={key}><input name={field.name} type="checkbox" defaultChecked={!!field.value} /><span>{field.name}</span></label>;
                return <label key={key}><span>{field.name}</span><input name={field.name} type={field.type === "password" ? "password" : "text"} defaultValue={field.type === "password" ? "" : String(field.value || "")} autoComplete="off" /></label>;
              })}
            </form>
            {sourceAction && <p className={sourceAction.status === "failed" ? "error" : ""}>{sourceAction.status === "running" ? "正在处理…" : sourceAction.error || sourceAction.message || "等待处理"}</p>}
            <footer><button onClick={clearSourceLogin}>退出并清除状态</button><span>{profile.login_state === "configured" ? "已保存登录状态" : "尚未保存登录状态"}</span></footer>
          </section>
        </div>
      )}

      {browserSession && (
        <div className="source-browser-backdrop">
          <section className="source-browser-panel">
            <header><div><h3>{browserSession.title}</h3><small>{browserSession.url}</small></div><button onClick={() => closeBrowser(false)} aria-label="取消">×</button></header>
            <div className="source-browser-screen">
              {browserFrame ? <img src={browserFrame} alt="网页操作画面" draggable={false} onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); sendBrowserEvent({ type: "click", x: (event.clientX - rect.left) * event.currentTarget.naturalWidth / rect.width, y: (event.clientY - rect.top) * event.currentTarget.naturalHeight / rect.height }); }} /> : <span>正在加载网页画面…</span>}
            </div>
            <div className="source-browser-controls">
              <input ref={browserTextRef} placeholder="输入到网页当前焦点" onKeyDown={(event) => { if (event.key === "Enter") { sendBrowserEvent({ type: "text", text: event.currentTarget.value }); event.currentTarget.value = ""; } }} />
              <button onClick={() => { const input = browserTextRef.current; if (input?.value) { sendBrowserEvent({ type: "text", text: input.value }); input.value = ""; } }}>输入</button>
              <button title="向上滚动" onClick={() => sendBrowserEvent({ type: "scroll", deltaY: -560 })}>↑</button>
              <button title="向下滚动" onClick={() => sendBrowserEvent({ type: "scroll", deltaY: 560 })}>↓</button>
              <button onClick={() => sendBrowserEvent({ type: "reload" })}>刷新</button>
              <button className="source-primary" onClick={() => closeBrowser(true)}>完成</button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

export default SourceSearchDialog;
