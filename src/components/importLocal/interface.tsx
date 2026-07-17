import BookModel from "../../models/Book";
import { RouteComponentProps } from "react-router";
import { ImportBookFunction } from "../../utils/request/bookSources";
export interface ImportLocalProps extends RouteComponentProps<any> {
  books: BookModel[];
  deletedBooks: BookModel[];

  isCollapsed: boolean;
  isServiceConnected: boolean;
  mode: string;
  shelfTitle: string;
  cloudSyncFunc: () => Promise<void>;
  handleFetchBooks: () => void;
  handleDrag: (isDrag: boolean) => void;
  handleImportDialog: (isOpenImportDialog: boolean) => void;
  handleOPDSDialog: (isOpen: boolean) => void;
  handleSourceSearchDialog: (isOpen: boolean) => void;
  handleImportBookFunc: (importBookFunc: ImportBookFunction) => void;
  handleReadingBook: (book: BookModel) => void;
  t: (title: string) => string;
}
export interface ImportLocalState {
  isOpenFile: boolean;
  isMoreOptionsVisible: boolean;
  width: number;
}
