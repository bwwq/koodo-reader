import { RouteComponentProps } from "react-router-dom";
export interface SettingInfoProps extends RouteComponentProps<any> {
  t: (title: string) => string;
  isServiceConnected: boolean;
  isNewWarning: boolean;
}
export interface SettingInfoState {}
