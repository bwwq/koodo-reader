import BookModel from "../../../models/Book";

export interface ConvertDialogProps {
  isSettingOpen: boolean;
  isAboutOpen: boolean;
  currentBook: BookModel;
  handleSetting: (isSettingOpen: boolean) => void;
  handleSettingMode: (mode: string) => void;
  handleConvertDialog: (isAboutOpen: boolean) => void;
  isServiceConnected: boolean;
  t: (title: string) => string;
  isSettingLocked: boolean;
}
export interface ConvertDialogState {
  isShowExportAll: boolean;
  isConvertPDF: boolean;
}
