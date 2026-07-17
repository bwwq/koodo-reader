import React from "react";
import Sidebar from "../../containers/sidebar";
import Header from "../../containers/header";
import DeleteDialog from "../../components/dialogs/deleteDialog";
import EditDialog from "../../components/dialogs/editDialog";
import AddDialog from "../../components/dialogs/addDialog";
import SortDialog from "../../components/dialogs/sortBookDialog";
import LocalFileDialog from "../../components/dialogs/localFileDialog";
import ImportDialog from "../../components/dialogs/importDialog";
import OPDSDialog from "../../components/dialogs/opdsDialog";
import SourceSearchDialog from "../../components/dialogs/sourceSearchDialog";
import { ManagerProps, ManagerState } from "./interface";
import { Trans } from "react-i18next";
import SettingDialog from "../../components/dialogs/settingDialog";
import { Route, Switch } from "react-router-dom";
import { routes } from "../../router/routes";
import Arrow from "../../components/arrow";
import LoadingDialog from "../../components/dialogs/loadingDialog";
import { Toaster } from "react-hot-toast";
import DetailDialog from "../../components/dialogs/detailDialog";
import { Tooltip } from "react-tooltip";
import { ConfigService } from "../../assets/lib/kookit-extra-browser.min";
import SortShelfDialog from "../../components/dialogs/sortShelfDialog";
import PopupNote from "../../components/popups/popupNote";
import toast from "react-hot-toast";
import { supportedFormats } from "../../utils/common";
import {
  isBookDragEvent,
  isExternalFileDragEvent,
} from "../../utils/reader/bookDrag";
import Footer from "../../components/footer";
import ProtectionOverlay from "../../components/protection";
import DatabaseService from "../../utils/storage/databaseService";
import {
  checkBookSubscription,
  createBookSubscriptionImport,
  downloadBookImport,
  getCompletedBookImports,
  getTrackedSourceBooks,
  listBookImports,
  listBookSubscriptions,
  markBookImportCompleted,
  untrackSourceBook,
  watchBookImport,
} from "../../utils/request/bookSources";

const sourceUpdateStageLabels: Record<string, string> = {
  queued: "等待处理",
  preparing: "准备更新",
  book_info: "解析详情",
  chapters: "下载章节",
  packaging: "生成 EPUB",
  ready: "准备替换",
};

class Manager extends React.Component<ManagerProps, ManagerState> {
  timer!: NodeJS.Timeout;
  private isDraggingFromApp = false;
  private sourceRefreshStarted = false;
  constructor(props: ManagerProps) {
    super(props);
    this.state = {
      totalBooks: parseInt(ConfigService.getReaderConfig("totalBooks")) || 0,
      favoriteBooks: Object.keys(
        ConfigService.getAllListConfig("favoriteBooks")
      ).length,
      isServiceConnected: false,
      isError: false,
      isCopied: false,
      isUpdated: false,
      isDrag: false,
      token: "",
    };
  }

  UNSAFE_componentWillReceiveProps(nextProps: ManagerProps) {
    if (nextProps.books && this.state.totalBooks !== nextProps.books.length) {
      this.setState(
        {
          totalBooks: nextProps.books.length,
        },
        () => {
          ConfigService.setReaderConfig(
            "totalBooks",
            this.state.totalBooks.toString()
          );
        }
      );
    }
    if (nextProps.books && nextProps.books.length === 1 && !this.props.books) {
      this.props.history.push("/manager/home");
    }
    if (this.props.mode !== nextProps.mode) {
      this.setState({
        favoriteBooks: Object.keys(
          ConfigService.getAllListConfig("favoriteBooks")
        ).length,
      });
    }
  }
  UNSAFE_componentWillMount() {
    this.props.handleFetchBooks();
    this.props.handleFetchPlugins();
    this.props.handleFetchNotes();
    this.props.handleFetchBookmarks();
    this.props.handleFetchBookSortCode();
    this.props.handleFetchNoteSortCode();
    this.props.handleFetchViewMode();
  }
  componentDidMount() {
    this.props.handleReadingState(false);
    document.addEventListener("dragstart", this.handleDocumentDragStart, true);
    document.addEventListener("dragend", this.handleDocumentDragEnd, true);
    document.addEventListener("dragenter", this.handleExternalDragEnter, true);
    // Auto switch to configured startup shelf
    const startupShelf = ConfigService.getReaderConfig("startupShelf");
    if (startupShelf) {
      const shelfList = ConfigService.getAllMapConfig("shelfList") || {};
      if (shelfList.hasOwnProperty(startupShelf)) {
        this.props.handleShelf(startupShelf);
        this.props.handleMode("shelf");
        this.props.history.push("/manager/shelf");
      }
    }
    void this.resumeSourceImports().finally(() => this.refreshSourceBooks());
  }

  resumeSourceImports = async () => {
    const response = await listBookImports();
    if (response.code !== 200 || !response.data?.length) return;
    const completed = new Set(getCompletedBookImports());
    const pending = response.data.filter((job) => !completed.has(job.id));
    if (!pending.length) return;

    const toastId = "source-import-recovery";
    for (const candidate of pending) {
      let job = candidate;
      if (job.status === "queued" || job.status === "running") {
        const watched = await watchBookImport(job.id, (next) => {
          job = next;
          const progress = next.total ? ` ${next.current}/${next.total}` : "";
          const stage = sourceUpdateStageLabels[next.stage] || "正在处理";
          toast.loading(`后台导入：${stage}${progress}`, { id: toastId });
        });
        if (watched.code !== 200) continue;
      }
      if (job.status !== "ready") continue;
      try {
        toast.loading("后台任务已完成，正在加入书架…", { id: toastId });
        const file = await downloadBookImport(job.id);
        let importedBookKey = "";
        await this.props.importBookFunc(file, {
          sourceSubscriptionId: job.subscription_id,
          onImported: (bookKey) => {
            importedBookKey = bookKey;
          },
        });
        if (!importedBookKey) throw new Error("图书未写入本地书架");
        markBookImportCompleted(job.id);
        toast.success(`已加入书架：${file.name.replace(/\.epub$/i, "")}`, {
          id: toastId,
        });
      } catch (error) {
        console.error("resume source import failed", error);
        toast.error("后台图书已生成，但加入书架失败；刷新后会重试", {
          id: toastId,
          duration: 5000,
        });
      }
    }
  };

  refreshSourceBooks = async () => {
    if (this.sourceRefreshStarted) return;
    this.sourceRefreshStarted = true;
    const tracked = getTrackedSourceBooks();
    if (!Object.keys(tracked).length) return;

    const subscriptions = await listBookSubscriptions();
    if (subscriptions.code !== 200 || !subscriptions.data) return;
    let updated = 0;
    let failed = 0;
    const toastId = "source-books-refresh";

    for (const subscription of subscriptions.data) {
      const bookKey = tracked[subscription.id];
      if (!bookKey) continue;
      const book = await DatabaseService.getRecord(bookKey, "books");
      if (!book) {
        untrackSourceBook(subscription.id);
        continue;
      }

      toast.loading(`检查更新：${subscription.title}`, { id: toastId });
      const checked = await checkBookSubscription(subscription.id);
      if (checked.code !== 200 || !checked.data) {
        failed++;
        continue;
      }
      if (!checked.data.update_available) continue;

      const created = await createBookSubscriptionImport(subscription.id);
      if ((created.code !== 202 && created.code !== 200) || !created.data) {
        failed++;
        continue;
      }
      let finalJob = created.data;
      const watched = await watchBookImport(created.data.id, (job) => {
        finalJob = job;
        const progress = job.total
          ? ` ${job.current}/${job.total}`
          : "";
        const stage = sourceUpdateStageLabels[job.stage] || "正在处理";
        toast.loading(`更新《${subscription.title}》：${stage}${progress}`, {
          id: toastId,
        });
      });
      if (watched.code !== 200 || finalJob.status !== "ready") {
        failed++;
        continue;
      }
      try {
        const file = await downloadBookImport(finalJob.id);
        await this.props.importBookFunc(file, {
          replaceBookKey: bookKey,
          sourceSubscriptionId: subscription.id,
          silent: true,
        });
        updated++;
      } catch (error) {
        console.error("source book update failed", error);
        failed++;
      }
    }

    if (failed) {
      toast.error(`书源更新完成：更新 ${updated} 本，失败 ${failed} 本`, {
        id: toastId,
        duration: 5000,
      });
    } else if (updated) {
      toast.success(`已更新 ${updated} 本书`, { id: toastId });
    } else {
      toast.dismiss(toastId);
    }
  };
  componentWillUnmount() {
    document.removeEventListener(
      "dragstart",
      this.handleDocumentDragStart,
      true
    );
    document.removeEventListener("dragend", this.handleDocumentDragEnd, true);
    document.removeEventListener(
      "dragenter",
      this.handleExternalDragEnter,
      true
    );
  }

  handleDocumentDragStart = (e: DragEvent) => {
    if (isBookDragEvent(e)) {
      this.isDraggingFromApp = true;
    }
  };
  handleDocumentDragEnd = () => {
    if (this.isDraggingFromApp) {
      this.handleDrag(false);
    }
    this.isDraggingFromApp = false;
  };
  handleExternalDragEnter = (e: DragEvent) => {
    if (isExternalFileDragEvent(e)) {
      this.handleDrag(true);
    }
  };

  handleDrag = (isDrag: boolean) => {
    this.setState({ isDrag });
  };
  render() {
    let { books } = this.props;
    const PopupProps = {
      chapterDocIndex: 0,
      chapter: "test",
    };
    return (
      <div
        className="manager"
        onDragEnter={(e) => {
          if (isExternalFileDragEvent(e)) {
            this.handleDrag(true);
          }
        }}
      >
        <ProtectionOverlay />
        <Tooltip id="my-tooltip" style={{ zIndex: 25 }} />
        {this.props.isShowPopupNote && (
          <div
            className="popup-box-container"
            style={{
              marginLeft: 0,
              height: "360px",
            }}
          >
            <PopupNote {...(PopupProps as any)} />
          </div>
        )}

        <div
          className={`drag-background${this.state.isDrag ? " drag-active" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onDrop={async (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.handleDrag(false);
            const collectFiles = (entry: FileSystemEntry): Promise<File[]> => {
              return new Promise((resolve) => {
                if (entry.isFile) {
                  (entry as FileSystemFileEntry).file(
                    (file) => resolve([file]),
                    () => resolve([])
                  );
                } else if (entry.isDirectory) {
                  const reader = (
                    entry as FileSystemDirectoryEntry
                  ).createReader();
                  const readAll = (
                    collected: FileSystemEntry[] = []
                  ): Promise<FileSystemEntry[]> =>
                    new Promise((res) => {
                      reader.readEntries(
                        (results) => {
                          if (results.length === 0) {
                            res(collected);
                          } else {
                            readAll([
                              ...collected,
                              ...Array.from(results),
                            ]).then(res);
                          }
                        },
                        () => res(collected)
                      );
                    });
                  readAll().then((entries) =>
                    Promise.all(entries.map(collectFiles)).then((arrays) =>
                      resolve(([] as File[]).concat(...arrays))
                    )
                  );
                } else {
                  resolve([]);
                }
              });
            };
            const items = e.dataTransfer.items;
            let allFiles: File[] = [];
            if (items && items.length > 0) {
              const entries: FileSystemEntry[] = [];
              for (let i = 0; i < items.length; i++) {
                const entry = items[i].webkitGetAsEntry();
                if (entry) entries.push(entry);
              }
              const fileArrays = await Promise.all(entries.map(collectFiles));
              allFiles = ([] as File[]).concat(...fileArrays);
            }
            for (const file of allFiles) {
              const ext = "." + file.name.split(".").pop()?.toLowerCase();
              if (!supportedFormats.includes(ext)) {
                toast.error(
                  this.props.t("Unsupported file format") + ": " + ext
                );
                continue;
              }
              await this.props.importBookFunc(file);
            }
            if (
              ConfigService.getReaderConfig("isDisableAutoSync") !== "yes" &&
              ConfigService.getItem("defaultSyncOption")
            ) {
              await this.props.cloudSyncFunc();
            }
          }}
          onClick={() => {
            this.props.handleEditDialog(false);
            this.props.handleDeleteDialog(false);
            this.props.handleAddDialog(false);
            this.props.handleDetailDialog(false);
            this.props.handleLoadingDialog(false);
            this.props.handleNewDialog(false);
            this.props.handleLocalFileDialog(false);
            this.props.handleImportDialog(false);
            this.props.handleShowPopupNote(false);
            this.props.handleSortShelfDialog(false);
            this.props.handleSetting(false);
            this.handleDrag(false);
          }}
          style={
            this.props.isSettingOpen ||
            this.props.isOpenImportDialog ||
            this.props.isOpenOPDSDialog ||
            this.props.isOpenSourceSearchDialog ||
            this.props.isOpenSortShelfDialog ||
            this.props.isShowNew ||
            this.props.isOpenDeleteDialog ||
            this.props.isOpenEditDialog ||
            this.props.isOpenLocalFileDialog ||
            this.props.isDetailDialog ||
            this.props.isShowPopupNote ||
            this.props.isOpenAddDialog ||
            this.props.isShowLoading ||
            this.state.isDrag
              ? {}
              : {
                  display: "none",
                }
          }
        >
          {this.state.isDrag && (
            <div className="drag-info">
              <p className="arrow-text">
                <Trans>Drop your books here</Trans>
              </p>
            </div>
          )}
        </div>
        <Sidebar />
        <Toaster
          toastOptions={{
            style: {
              wordWrap: "break-word",
              wordBreak: "break-word",
              whiteSpace: "normal",
              overflowWrap: "break-word",
            },
          }}
        />
        <Header {...({ handleDrag: this.handleDrag } as any)} />
        {this.props.isOpenDeleteDialog && <DeleteDialog />}
        {this.props.isOpenEditDialog && <EditDialog />}
        {this.props.isOpenAddDialog && <AddDialog />}
        {this.props.isShowLoading && <LoadingDialog />}
        {this.props.isSortDisplay && <SortDialog />}
        {this.props.isOpenLocalFileDialog && <LocalFileDialog />}
        {this.props.isOpenImportDialog && <ImportDialog />}
        {this.props.isOpenOPDSDialog && <OPDSDialog />}
        {this.props.isOpenSourceSearchDialog && <SourceSearchDialog />}
        {this.props.isOpenSortShelfDialog && <SortShelfDialog />}
        {this.props.isSettingOpen && <SettingDialog />}
        {this.props.isDetailDialog && <DetailDialog />}
        {(!books || books.length === 0) && this.state.totalBooks ? null : (
          <Switch>
            {routes.map((ele) => (
              <Route
                render={() => <ele.component />}
                key={ele.path}
                path={ele.path}
              />
            ))}
          </Switch>
        )}
        <Footer />
      </div>
    );
  }
}
export default Manager;
