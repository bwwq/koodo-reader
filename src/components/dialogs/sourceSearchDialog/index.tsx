import { connect } from "react-redux";
import { withTranslation } from "react-i18next";
import { stateType } from "../../../store";
import { handleSourceSearchDialog } from "../../../store/actions";
import SourceSearchDialog from "./component";

const mapStateToProps = (state: stateType) => ({
  importBookFunc: state.book.importBookFunc,
});

export default connect(mapStateToProps, { handleSourceSearchDialog })(
  withTranslation()(SourceSearchDialog as any) as any
);
