import {
  handleFetchNotes,
  handleFetchBookmarks,
  handleFetchBooks,
  handleReadingBook,
  handleFetchPercentage,
  handleReaderMode,
  handleMenuMode,
  handleOriginalText,
  handleOpenMenu,
  handleConvertDialog,
  handlePdfCropDialog,
  handleSpeechDialog,
  handleAnnotationDialog,
  handleScale,
  handleFetchServiceConnected,
  handleFetchServiceUser,
  handleBackgroundColor,
} from "../../store/actions";
import { connect } from "react-redux";
import { stateType } from "../../store";
import Reader from "./component";
import { withTranslation } from "react-i18next";

const mapStateToProps = (state: stateType) => {
  return {
    currentBook: state.book.currentBook,
    percentage: state.progressPanel.percentage,
    htmlBook: state.reader.htmlBook,
    readerMode: state.reader.readerMode,
    isNavLocked: state.reader.isNavLocked,
    isConvertOpen: state.reader.isConvertOpen,
    isPdfCropOpen: state.reader.isPdfCropOpen,
    isSpeechOpen: state.reader.isSpeechOpen,
    isAnnotationOpen: state.reader.isAnnotationOpen,
    isOpenPopupOptionDialog: state.backupPage.isOpenPopupOptionDialog,
    isSettingLocked: state.reader.isSettingLocked,
    isServiceConnected: state.manager.isServiceConnected,
    isSearch: state.manager.isSearch,
    isSettingOpen: state.manager.isSettingOpen,
    scale: state.reader.scale,
    renderBookFunc: state.book.renderBookFunc,
  };
};
const actionCreator = {
  handleFetchNotes,
  handleFetchBookmarks,
  handleFetchBooks,
  handleReadingBook,
  handleFetchPercentage,
  handleReaderMode,
  handleMenuMode,
  handleOriginalText,
  handleOpenMenu,
  handleConvertDialog,
  handlePdfCropDialog,
  handleScale,
  handleFetchServiceConnected,
  handleSpeechDialog,
  handleAnnotationDialog,
  handleFetchServiceUser,
  handleBackgroundColor,
};
export default connect(
  mapStateToProps,
  actionCreator
)(withTranslation()(Reader as any) as any);
