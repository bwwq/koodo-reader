import React from "react";
import { Trans } from "react-i18next";
import toast from "react-hot-toast";
import { ConfigService } from "../../../assets/lib/kookit-extra-browser.min";
import DatabaseService from "../../../utils/storage/databaseService";
import ConfigUtil from "../../../utils/file/configUtil";
import { vexComfirmAsync } from "../../../utils/common";
import { getServiceDevice } from "../../../utils/request/user";
import {
  bindSyncToCurrentUser,
  createAdminInvites,
  getAdminConfig,
  getAdminUsers,
  getAuthConfig,
  getBoundSyncServiceBaseUrl,
  getBoundSyncUserId,
  getServiceHealth,
  loginServiceAccount,
  logoutServiceAccount,
  registerServiceAccount,
  resetServiceCache,
  setServiceBaseUrl,
  updateAdminConfig,
} from "../../../utils/request/service";
import { SettingInfoProps, SettingInfoState } from "./interface";

const defaultServiceBaseUrl =
  typeof window !== "undefined" && /^https?:$/.test(window.location.protocol)
    ? window.location.origin
    : "";

class AccountSetting extends React.Component<
  SettingInfoProps,
  SettingInfoState
> {
  state: SettingInfoState = {
    serviceBaseUrl:
      ConfigService.getItem("serviceBaseUrl") || defaultServiceBaseUrl,
    username: "",
    password: "",
    confirmPassword: "",
    inviteCode: "",
    registrationMode: "admin",
    isRegistering: false,
    isLoading: false,
    serviceVersion: "",
    capabilities: [],
    healthMessage: "",
    adminRegistrationMode: "invite",
    serviceName: "Koodo Reader",
    inviteDays: "7",
    generatedInvites: [],
    adminUsers: [],
  };

  async componentDidMount() {
    if (!ConfigService.getItem("serviceBaseUrl") && defaultServiceBaseUrl) {
      await setServiceBaseUrl(defaultServiceBaseUrl);
    }
    await this.refreshServiceInfo();
    await this.props.handleFetchServiceConnected();
    if (this.props.isServiceConnected) {
      const account = await this.props.handleFetchServiceUser();
      if (account?.role === "admin") await this.refreshAdminInfo();
    }
  }

  componentDidUpdate(previousProps: SettingInfoProps) {
    if (
      previousProps.serviceUser?.role !== "admin" &&
      this.props.serviceUser?.role === "admin"
    ) {
      this.refreshAdminInfo();
    }
  }

  refreshServiceInfo = async (force = false) => {
    if (!ConfigService.getItem("serviceBaseUrl")) return false;
    if (force) resetServiceCache();
    const [health, authConfig] = await Promise.all([
      getServiceHealth(force),
      getAuthConfig(),
    ]);
    this.setState({
      serviceVersion: health.code === 200 ? health.data.version : "",
      capabilities:
        health.code === 200 ? health.data.capabilities || [] : [],
      registrationMode:
        authConfig.code === 200
          ? authConfig.data.registration_mode
          : "admin",
      isRegistering:
        authConfig.code === 200 &&
        authConfig.data.registration_mode === "bootstrap",
      serviceName:
        authConfig.code === 200 && authConfig.data.service_name
          ? authConfig.data.service_name
          : this.state.serviceName,
      healthMessage:
        health.code === 200
          ? this.props.t("Connection successful")
          : health.msg || this.props.t("Connection failed"),
    });
    return health.code === 200;
  };

  refreshAdminInfo = async () => {
    const [config, users] = await Promise.all([
      getAdminConfig(),
      getAdminUsers(),
    ]);
    if (config.code === 200) {
      this.setState({
        adminRegistrationMode: config.data.registration_mode,
        serviceName: config.data.service_name,
      });
    }
    if (users.code === 200) this.setState({ adminUsers: users.data || [] });
  };

  saveAdminConfig = async () => {
    this.setState({ isLoading: true });
    try {
      const response = await updateAdminConfig({
        registration_mode: this.state.adminRegistrationMode,
        service_name: this.state.serviceName.trim(),
      });
      if (response.code !== 200) throw new Error(response.msg);
      await this.refreshServiceInfo(true);
      toast.success(this.props.t("Service settings saved"));
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : this.props.t("Failed to save service settings")
      );
    } finally {
      this.setState({ isLoading: false });
    }
  };

  createInvites = async () => {
    const days = Number(this.state.inviteDays);
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      toast.error(this.props.t("Invitation validity must be 1-365 days"));
      return;
    }
    this.setState({ isLoading: true });
    try {
      const response = await createAdminInvites({
        count: 1,
        expires_in_days: days,
      });
      if (response.code !== 200) throw new Error(response.msg);
      this.setState({ generatedInvites: response.data.codes || [] });
      toast.success(this.props.t("Invitation code created"));
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : this.props.t("Failed to create invitation code")
      );
    } finally {
      this.setState({ isLoading: false });
    }
  };

  saveAndTestAddress = async () => {
    this.setState({ isLoading: true });
    try {
      await setServiceBaseUrl(this.state.serviceBaseUrl);
      ConfigUtil.resetOnlineState();
      await this.props.handleFetchServiceConnected();
      const connected = await this.refreshServiceInfo(true);
      if (connected) {
        toast.success(this.props.t("Connection successful"));
      } else {
        toast.error(this.props.t("Connection failed"));
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : this.props.t("Invalid URL")
      );
    } finally {
      this.setState({ isLoading: false });
    }
  };

  validateCredentials = () => {
    if (!/^[A-Za-z0-9._-]{3,32}$/.test(this.state.username)) {
      toast.error(
        this.props.t(
          "Username must be 3-32 letters, numbers, dots, underscores or hyphens"
        )
      );
      return false;
    }
    if (this.state.password.length < 8 || this.state.password.length > 128) {
      toast.error(this.props.t("Password must be 8-128 characters"));
      return false;
    }
    return true;
  };

  handleLogin = async () => {
    if (!this.validateCredentials()) return;
    this.setState({ isLoading: true });
    try {
      await setServiceBaseUrl(this.state.serviceBaseUrl);
      ConfigUtil.resetOnlineState();
      const response = await loginServiceAccount({
        username: this.state.username,
        password: this.state.password,
        device: await getServiceDevice(),
      });
      if (response.code !== 200) throw new Error(response.msg);
      this.setState({ password: "", confirmPassword: "" });
      await this.props.handleFetchServiceConnected();
      const account = await this.props.handleFetchServiceUser();
      if (account?.role === "admin") await this.refreshAdminInfo();
      this.props.handleFetchPlugins();
      toast.success(this.props.t("Log in successful"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : this.props.t("Login failed"));
    } finally {
      this.setState({ isLoading: false });
    }
  };

  handleRegister = async () => {
    if (!this.validateCredentials()) return;
    if (this.state.password !== this.state.confirmPassword) {
      toast.error(this.props.t("Passwords do not match"));
      return;
    }
    if (
      this.state.registrationMode === "invite" &&
      !this.state.inviteCode.trim()
    ) {
      toast.error(this.props.t("Please enter invitation code"));
      return;
    }
    this.setState({ isLoading: true });
    try {
      await setServiceBaseUrl(this.state.serviceBaseUrl);
      const response = await registerServiceAccount({
        username: this.state.username,
        password: this.state.password,
        invite_code: this.state.inviteCode.trim(),
      });
      if (response.code !== 200) throw new Error(response.msg);
      toast.success(response.msg || this.props.t("Registration successful, please log in"));
      this.setState({ isRegistering: false, confirmPassword: "", inviteCode: "" });
      await this.refreshServiceInfo(true);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : this.props.t("Registration failed")
      );
    } finally {
      this.setState({ isLoading: false });
    }
  };

  handleLogout = async () => {
    await logoutServiceAccount();
    ConfigUtil.resetOnlineState();
    await this.props.handleFetchServiceConnected();
    this.props.handleFetchPlugins();
    toast.success(this.props.t("Log out successful"));
  };

  handleBind = async () => {
    const user = this.props.serviceUser;
    if (!user) return;
    const currentBinding = getBoundSyncUserId();
    const currentServiceBinding = getBoundSyncServiceBaseUrl();
    const isAnotherBinding = Boolean(
      currentBinding &&
        (currentBinding !== user.id ||
          (currentServiceBinding &&
            currentServiceBinding !== ConfigService.getItem("serviceBaseUrl")))
    );
    if (isAnotherBinding) {
      const books = await DatabaseService.getAllRecordKeys("books");
      if (books.length > 0) {
        toast.error(
          this.props.t(
            "Export a backup and clear the local library before binding another account"
          )
        );
        return;
      }
      const confirmed = await vexComfirmAsync(
        this.props.t(
          "The local library is empty. Confirm that you exported a backup before changing the bound account."
        )
      );
      if (!confirmed) return;
      ConfigService.setItem("boundSyncUserId", "");
      ConfigService.setItem("boundSyncServiceBaseUrl", "");
    }
    if (await bindSyncToCurrentUser()) {
      ConfigUtil.resetOnlineState();
      toast.success(this.props.t("Current account is bound to online sync"));
      this.forceUpdate();
    }
  };

  renderInput = (
    label: string,
    key:
      | "serviceBaseUrl"
      | "username"
      | "password"
      | "confirmPassword"
      | "inviteCode"
      | "serviceName"
      | "inviteDays",
    type = "text",
    placeholder = ""
  ) => (
    <div className="setting-dialog-new-title" style={{ alignItems: "center" }}>
      <Trans>{label}</Trans>
      <input
        className="setting-dialog-new-input"
        style={{ width: "55%" }}
        type={type}
        value={this.state[key]}
        placeholder={this.props.t(placeholder)}
        onChange={(event) => this.setState({ [key]: event.target.value } as any)}
        autoComplete={key === "password" ? "current-password" : "off"}
      />
    </div>
  );

  renderAdminSettings = () => (
    <>
      <div className="setting-dialog-new-title">
        <strong><Trans>Service administration</Trans></strong>
        <span><Trans>Administrator</Trans></span>
      </div>
      {this.renderInput("Service name", "serviceName", "text")}
      <div className="setting-dialog-new-title" style={{ alignItems: "center" }}>
        <Trans>Registration mode</Trans>
        <select
          className="setting-dialog-new-input"
          style={{ width: "55%" }}
          value={this.state.adminRegistrationMode}
          onChange={(event) =>
            this.setState({
              adminRegistrationMode: event.target.value as "admin" | "invite",
            })
          }
        >
          <option value="invite">{this.props.t("Invitation code registration")}</option>
          <option value="admin">{this.props.t("Disable registration")}</option>
        </select>
      </div>
      <div className="setting-dialog-new-title">
        <Trans>Save service settings</Trans>
        <button
          className="change-location-button"
          disabled={this.state.isLoading}
          onClick={this.saveAdminConfig}
        >
          <Trans>Save</Trans>
        </button>
      </div>
      {this.state.adminRegistrationMode === "invite" && (
        <>
          {this.renderInput("Invitation validity (days)", "inviteDays", "number")}
          <div className="setting-dialog-new-title">
            <Trans>Create invitation code</Trans>
            <button
              className="change-location-button"
              disabled={this.state.isLoading}
              onClick={this.createInvites}
            >
              <Trans>Generate</Trans>
            </button>
          </div>
          {this.state.generatedInvites.length > 0 && (
            <p className="setting-option-subtitle">
              <Trans>New invitation code</Trans>: {" "}
              <code style={{ userSelect: "all", fontWeight: 600 }}>
                {this.state.generatedInvites.join(", ")}
              </code>
              <br />
              <Trans>This code is displayed only once. Save it now.</Trans>
            </p>
          )}
        </>
      )}
      <div className="setting-dialog-new-title">
        <Trans>Registered accounts</Trans>
        <span>
          {this.state.adminUsers.map((account) =>
            `${account.username}${account.role === "admin" ? ` (${this.props.t("Administrator")})` : ""}`
          ).join(", ") || "-"}
        </span>
      </div>
    </>
  );

  render() {
    const boundUserId = getBoundSyncUserId();
    const boundServiceBaseUrl = getBoundSyncServiceBaseUrl();
    const isBound = Boolean(
      this.props.serviceUser &&
        boundUserId === this.props.serviceUser.id &&
        boundServiceBaseUrl === ConfigService.getItem("serviceBaseUrl")
    );
    return (
      <div>
        {this.renderInput(
          "Service address",
          "serviceBaseUrl",
          "url",
          "https://reader.example.com"
        )}
        <p className="setting-option-subtitle">
          <Trans>
            Account login, online sync and OAuth use this address. Public update and documentation services remain unchanged.
          </Trans>
        </p>
        <div className="setting-dialog-new-title">
          <Trans>Service status</Trans>
          <div>
            <span style={{ opacity: 0.7, marginRight: 12 }}>
              {this.state.healthMessage}
              {this.state.serviceVersion ? ` · v${this.state.serviceVersion}` : ""}
            </span>
            <button
              className="change-location-button"
              disabled={this.state.isLoading}
              onClick={this.saveAndTestAddress}
            >
              <Trans>Save and test</Trans>
            </button>
          </div>
        </div>
        {this.state.capabilities.length > 0 && (
          <p className="setting-option-subtitle">
            {this.props.t("Capabilities")}: {this.state.capabilities.join(", ")}
          </p>
        )}

        {this.props.isServiceConnected && this.props.serviceUser ? (
          <>
            <div className="setting-dialog-new-title">
              <Trans>Current account</Trans>
              <span>
                {this.props.serviceUser.displayName || this.props.serviceUser.username}
                {` (${this.props.serviceUser.username})`}
                {this.props.serviceUser.role === "admin"
                  ? ` · ${this.props.t("Administrator")}`
                  : ""}
              </span>
            </div>
            <div className="setting-dialog-new-title">
              <Trans>Online sync binding</Trans>
              <div>
                <span style={{ opacity: 0.7, marginRight: 12 }}>
                  {isBound
                    ? this.props.t("Bound to current account")
                    : boundUserId
                      ? this.props.t("Bound to another account")
                      : this.props.t("Not bound")}
                </span>
                {!isBound && (
                  <button className="change-location-button" onClick={this.handleBind}>
                    <Trans>Bind current account</Trans>
                  </button>
                )}
              </div>
            </div>
            {!isBound && boundUserId && (
              <p className="setting-option-subtitle">
                <Trans>
                  This account may use stateless online services, but shared local reading data will not be synchronized until the library is safely rebound.
                </Trans>
              </p>
            )}
            {this.props.serviceUser.role === "admin" &&
              this.renderAdminSettings()}
            <div className="setting-dialog-new-title">
              <Trans>Log out</Trans>
              <button className="change-location-button" onClick={this.handleLogout}>
                <Trans>Log out</Trans>
              </button>
            </div>
            <p className="setting-option-subtitle">
              <Trans>
                Logging out only clears the online service session. Local books, AI settings and storage credentials stay on this device.
              </Trans>
            </p>
          </>
        ) : (
          <>
            {this.renderInput("Username", "username", "text")}
            {this.renderInput("Password", "password", "password")}
            {this.state.isRegistering &&
              this.renderInput("Confirm password", "confirmPassword", "password")}
            {this.state.isRegistering &&
              this.state.registrationMode === "invite" &&
              this.renderInput("Invitation code", "inviteCode", "text")}
            <div className="setting-dialog-new-title">
              <Trans>
                {this.state.registrationMode === "bootstrap"
                  ? "Create first administrator"
                  : this.state.isRegistering
                    ? "Create account"
                    : "Log in"}
              </Trans>
              <div>
                {this.state.registrationMode === "invite" && (
                  <button
                    className="change-location-button"
                    style={{ marginRight: 12 }}
                    onClick={() =>
                      this.setState({ isRegistering: !this.state.isRegistering })
                    }
                  >
                    <Trans>{this.state.isRegistering ? "Back to login" : "Register with invitation code"}</Trans>
                  </button>
                )}
                <button
                  className="change-location-button"
                  disabled={this.state.isLoading}
                  onClick={this.state.isRegistering ? this.handleRegister : this.handleLogin}
                >
                    <Trans>
                      {this.state.registrationMode === "bootstrap"
                        ? "Create administrator"
                        : this.state.isRegistering
                          ? "Register"
                          : "Log in"}
                    </Trans>
                </button>
              </div>
            </div>
            {this.state.registrationMode === "admin" && (
              <p className="setting-option-subtitle">
                <Trans>Registration is disabled. Ask the service administrator to create an account.</Trans>
              </p>
            )}
            {this.state.registrationMode === "bootstrap" && (
              <p className="setting-option-subtitle">
                <Trans>The first registered account becomes the administrator and can configure this service.</Trans>
              </p>
            )}
          </>
        )}
      </div>
    );
  }
}

export default AccountSetting;
