import { RouteComponentProps } from "react-router-dom";
import { ServiceUser } from "../../../utils/request/service";

export interface SettingInfoProps extends RouteComponentProps<any> {
  t: (title: string) => string;
  serviceUser: ServiceUser | null;
  isServiceConnected: boolean;
  handleFetchServiceConnected: () => Promise<void>;
  handleFetchServiceUser: () => Promise<ServiceUser | null>;
  handleFetchPlugins: () => void;
}

export interface SettingInfoState {
  serviceBaseUrl: string;
  username: string;
  password: string;
  confirmPassword: string;
  inviteCode: string;
  registrationMode: "bootstrap" | "admin" | "invite";
  isRegistering: boolean;
  isLoading: boolean;
  serviceVersion: string;
  capabilities: string[];
  healthMessage: string;
  adminRegistrationMode: "admin" | "invite";
  serviceName: string;
  inviteDays: string;
  generatedInvites: string[];
  adminUsers: ServiceUser[];
}
