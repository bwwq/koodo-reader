import { connect } from "react-redux";
import DataSetting from "./component";
import { withTranslation } from "react-i18next";
import { stateType } from "../../../store";
import { withRouter } from "react-router-dom";
import { handleFetchBooks } from "../../../store/actions";

const mapStateToProps = (state: stateType) => {
  return {
    isServiceConnected: state.manager.isServiceConnected,
  };
};
const actionCreator = { handleFetchBooks };
export default connect(
  mapStateToProps,
  actionCreator
)(withTranslation()(withRouter(DataSetting as any) as any) as any);
