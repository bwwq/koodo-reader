import { connect } from "react-redux";
import { withTranslation } from "react-i18next";
import DropdownList from "./component";
import { stateType } from "../../../store";
import {
  handleHideBackground,
  handleTextOrientation,
  handleSetting,
  handleSettingMode,
} from "../../../store/actions";

const mapStateToProps = (state: stateType) => {
  return {
    renderBookFunc: state.book.renderBookFunc,
    currentBook: state.book.currentBook,
    isServiceConnected: state.manager.isServiceConnected,
  };
};
const actionCreator = {
  handleHideBackground,
  handleTextOrientation,
  handleSetting,
  handleSettingMode,
};
export default connect(
  mapStateToProps,
  actionCreator
)(withTranslation()(DropdownList as any) as any);
