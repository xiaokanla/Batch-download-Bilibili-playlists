/* Eagle injects the `eagle` bridge before this file is evaluated. */
window.pluginReady = new Promise((resolve) => {
  if (window.eagle && typeof eagle.onPluginCreate === "function") {
    eagle.onPluginCreate((plugin) => resolve(plugin));
    return;
  }
  resolve({ manifest: { name: "标签蛛网图", version: "demo" }, path: "" });
});

if (window.eagle && typeof eagle.onLibraryChanged === "function") {
  eagle.onLibraryChanged(() => window.dispatchEvent(new Event("eagle-library-changed")));
}

if (window.eagle && typeof eagle.onThemeChanged === "function") {
  eagle.onThemeChanged((theme) => {
    document.documentElement.dataset.eagleTheme = String(theme || "").toLowerCase();
  });
}
