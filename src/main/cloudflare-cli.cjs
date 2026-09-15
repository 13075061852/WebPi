// Wrangler's argument parser otherwise treats Electron-as-Node as a packaged GUI
// and includes the script filename in the command arguments.
process.defaultApp = true;
