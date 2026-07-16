import BookModel from "../../../models/Book";
import PluginModel from "../../../models/Plugin";
import { RouteComponentProps } from "react-router-dom";
export interface SettingInfoProps extends RouteComponentProps<any> {
  handleSetting: (isSettingOpen: boolean) => void;
  handleSettingMode: (settingMode: string) => void;
  handleSettingDrive: (settingDrive: string) => void;
  handleTokenDialog: (isOpenTokenDialog: boolean) => void;
  handleFetchDataSourceList: () => void;
  handleFetchDefaultSyncOption: () => void;
  handleDefaultSyncOption: (defaultSyncOption: string) => void;
  handleFetchLoginOptionList: () => void;
  serviceUser: any;
  handleLoginOptionList: (
    loginOptionList: { email: string; provider: string }[]
  ) => void;
  handleFetchServiceConnected: () => void;
  handleLoadingDialog: (isShow: boolean) => void;
  t: (title: string) => string;
  handleFetchBooks: () => void;
  handleFetchPlugins: () => void;
  cloudSyncFunc: (serviceUser: any) => Promise<void>;
  handleFetchServiceUser: () => Promise<any>;
  plugins: PluginModel[];
  books: BookModel[];
  dataSourceList: string[];
  loginOptionList: { email: string; provider: string }[];
  defaultSyncOption: string;
  isServiceConnected: boolean;
  settingDrive: string;
}
export interface SettingInfoState {
  isKeepLocal: boolean;
  isEnableOnlineSync: boolean;
  isDisableAutoSync: boolean;
  autoOffline: boolean;
  hideSyncProgress: boolean;
  driveConfig: any;
  scheduledSyncInterval: string;
  backupDrive: string;
  restoreDrive: string;
  showDefaultSyncAddGrid: boolean;
}
