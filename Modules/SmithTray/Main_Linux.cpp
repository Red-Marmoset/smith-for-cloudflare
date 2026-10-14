// Linux entry point. wxWidgets supplies main() via wxIMPLEMENT_APP.
// Note: tray support on Linux depends on the desktop environment's StatusNotifier
// / AppIndicator support; the tray is best-effort there.
#include "TrayApp.h"

wxIMPLEMENT_APP(SmithTrayApp::TrayApp);
