import { connect } from "react-redux";
import AccountSetting from "./component";
import { withTranslation } from "react-i18next";
import {
  handleFetchPlugins,
  handleFetchServiceConnected,
  handleFetchServiceUser,
} from "../../../store/actions";
import { stateType } from "../../../store";
import { withRouter } from "react-router-dom";

const mapStateToProps = (state: stateType) => ({
  isServiceConnected: state.manager.isServiceConnected,
  serviceUser: state.manager.serviceUser,
});

export default connect(mapStateToProps, {
  handleFetchPlugins,
  handleFetchServiceConnected,
  handleFetchServiceUser,
})(withTranslation()(withRouter(AccountSetting as any) as any) as any);
