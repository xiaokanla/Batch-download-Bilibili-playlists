const $ = (id) => document.getElementById(id);

const app = {
  state: null,
  mode: "fav",
  selected: new Set(),
  page: 1,
  pageSize: 24,
  search: "",
  duration: "全部时长",
  undoneOnly: false,
  groupByMonth: true,
  monthFilter: "",
  selectedYear: "",
  selectedFavId: "",
  pollingQr: null,
  listSignature: "",
  foldersSignature: "",
  logsSignature: "",
  eagleFolders: [],
  eagleFoldersLibrary: "",
  eagleFoldersLoading: false,
  diagnostics: null,
  diagnosticsLoading: false,
};

async function api(path, options = {}) {
  const res = await fetch(path, {
    method: options.method || "GET",
    headers: { "Content-Type": "application/json" },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const contentType = res.headers.get("Content-Type") || "";
  if (!contentType.includes("application/json")) {
    const text = await res.text();
    const preview = text.trim().slice(0, 80);
    throw new Error(`后端接口返回异常，可能是打开了旧版本服务或接口不存在：${path}${preview ? `（${preview}...）` : ""}`);
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "请求失败");
  return data;
}

function normalizeCover(url) {
  if (!url) return "";
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("http://")) return `https://${url.slice(7)}`;
  return url;
}

function proxyCover(url) {
  const normalized = normalizeCover(url);
  return normalized ? `/api/image?url=${encodeURIComponent(normalized)}` : "";
}

function formatDuration(seconds) {
  if (!seconds) return "--:--";
  const s = Number(seconds) || 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function currentItems() {
  if (!app.state) return [];
  return app.mode === "fav" ? app.state.favVideos : app.state.manualVideos;
}

function historySet() {
  return new Set(app.state?.history || []);
}

function filteredItems() {
  const keyword = app.search.trim().toLowerCase();
  const history = historySet();
  return currentItems().filter((item) => {
    if (keyword && !`${item.title} ${item.bvid}`.toLowerCase().includes(keyword)) return false;
    if (app.mode === "fav" && app.monthFilter && item.month !== app.monthFilter) return false;
    if (app.undoneOnly && history.has(item.bvid)) return false;
    const d = Number(item.duration || 0);
    if (app.duration === "<1分钟" && !(d < 60)) return false;
    if (app.duration === "1-3分钟" && !(d >= 60 && d < 180)) return false;
    if (app.duration === "3-5分钟" && !(d >= 180 && d < 300)) return false;
    if (app.duration === "5-10分钟" && !(d >= 300 && d < 600)) return false;
    if (app.duration === ">10分钟" && !(d >= 600)) return false;
    return true;
  });
}

function renderState() {
  if (!app.state) return;
  $('userName').textContent = app.state.user?.name || "未登录";
  $("envLine").textContent = `${app.state.env.ffmpeg ? "FFmpeg 就绪" : "FFmpeg 未检测"} · ${app.state.env.aria2 ? "Aria2 就绪" : "Aria2 未检测"}`;
  $("syncProgress").style.width = `${Math.round((app.state.sync?.progress || 0) * 100)}%`;
  $("metricSync").textContent = app.state.sync?.running ? "Syncing" : "Idle";

  renderFavSelect();
  renderMetrics();
  renderChart();
  renderListIfNeeded();
  renderDownload();
  renderEagle();
  renderDiagnostics();
  renderGuide();
  renderSettings();
  renderLogs();
}

function guideStatus() {
  const loggedIn = Boolean(app.state?.user?.loggedIn);
  const hasFolders = Boolean((app.state?.favFolders || []).length || Object.keys(app.state?.favData || {}).length);
  const hasVideos = Boolean((app.state?.favVideos || []).length || (app.state?.manualVideos || []).length);
  const hasSelected = app.selected.size > 0;
  const hasDownloadDir = Boolean(($("saveDir")?.value || app.state?.settings?.downloadDir || "").trim());
  const hasDownloadedLocalVideos = Object.values(app.state?.downloadRecords || {}).some((record) => record.path);
  const eagleLibrary = Boolean(($("eagleLibrary")?.value || app.state?.eagle?.libraryDir || "").trim());
  if (!loggedIn) {
    return {
      step: 1,
      title: "先扫码登录 B站",
      description: "登录后才能读取你的收藏夹。点击左侧“扫码登录”，用 B站 App 扫码即可。",
      action: "扫码登录",
      target: "loginBtn",
      help: "没有账号也可以先用“提取视频/特殊链接”添加单个视频。",
    };
  }
  if (!hasFolders || !hasVideos) {
    return {
      step: 2,
      title: "选择收藏夹，然后同步列表",
      description: hasFolders ? "已经读取到收藏夹，选择一个收藏夹后点击“同步收藏夹”。" : "如果左侧没有收藏夹，请先确认登录状态，再点击同步或导入外部收藏夹。",
      action: "同步收藏夹",
      target: "syncBtn",
      help: "同步只会读取列表，不会开始下载。",
    };
  }
  if (!hasSelected || !hasDownloadDir) {
    return {
      step: 3,
      title: hasSelected ? "选择下载目录，然后开始下载" : "勾选要下载的视频",
      description: hasSelected ? "右侧选择保存目录后，点击“启动下载”。" : "在中间列表点击视频卡片或复选框，至少选择一个视频。",
      action: hasSelected ? (hasDownloadDir ? "启动下载" : "选择下载目录") : "全选当前筛选",
      target: hasSelected ? (hasDownloadDir ? "startBtn" : "chooseDirBtn") : "selectAllBtn",
      help: "下载完成后，程序会自动记录 BV 号，避免以后重复下载。",
    };
  }
  return {
    step: 4,
    title: hasDownloadedLocalVideos ? "可选：导入 Eagle 并生成封面" : "下载完成后可以导入 Eagle",
    description: hasDownloadedLocalVideos
      ? (eagleLibrary ? "Eagle 库已设置，可以点击“导入已下载视频到 Eagle”。" : "打开 Eagle 后，先选择 .library 库目录，再导入。")
      : "先完成下载。下载完成后，这里会引导你把视频导入 Eagle。",
    action: hasDownloadedLocalVideos ? (eagleLibrary ? "导入 Eagle" : "选择 Eagle 库") : "查看下载状态",
    target: hasDownloadedLocalVideos ? (eagleLibrary ? "eagleImportBtn" : "chooseEagleBtn") : "startBtn",
    help: "不使用 Eagle 的话，到下载完成这一步就可以结束。",
  };
}

function renderGuide() {
  const guide = guideStatus();
  if (!$("guideTitle")) return;
  $("guideTitle").textContent = guide.title;
  $("guideDescription").textContent = guide.description;
  $("guidePrimaryBtn").textContent = guide.action;
  $("guideHelpBtn").textContent = guide.help || "查看环境诊断";
  $("syncHint").textContent = guide.step <= 2 ? guide.help : "列表同步后，在中间选择要下载的视频。";
  document.querySelectorAll(".guide-step").forEach((item) => {
    const step = Number(item.dataset.guideStep || 0);
    item.classList.toggle("active", step === guide.step);
    item.classList.toggle("done", step < guide.step);
  });
}

function renderFavSelect() {
  const entries = (app.state.favFolders && app.state.favFolders.length)
    ? app.state.favFolders.map((item) => [item.name, item.fid])
    : Object.entries(app.state.favData || {});
  const signature = JSON.stringify(entries);
  if (!entries.some(([, fid]) => String(fid) === String(app.selectedFavId))) {
    app.selectedFavId = entries.length ? String(entries[0][1]) : "";
  }
  if (signature === app.foldersSignature) {
    updateFavDropdownLabel(entries);
    return;
  }
  app.foldersSignature = signature;
  const menu = $("favDropdownMenu");
  if (!entries.length) {
    menu.innerHTML = `<div class="dropdown-empty">暂无收藏夹</div>`;
  } else {
    menu.innerHTML = entries.map(([name, fid]) => `
      <button class="dropdown-item ${String(fid) === String(app.selectedFavId) ? "active" : ""}" data-fid="${escapeAttr(fid)}" data-name="${escapeAttr(name)}">
        ${escapeHtml(name)}
      </button>
    `).join("");
    menu.querySelectorAll(".dropdown-item").forEach((item) => {
      item.onclick = () => {
        app.selectedFavId = String(item.dataset.fid);
        closeFavDropdown();
        renderFavSelect();
      };
    });
  }
  updateFavDropdownLabel(entries);
}

function updateFavDropdownLabel(entries = Object.entries(app.state?.favData || {})) {
  const found = entries.find(([, fid]) => String(fid) === String(app.selectedFavId));
  $("favDropdownLabel").textContent = found ? found[0] : "请选择收藏夹";
  $("favDropdownMenu").querySelectorAll(".dropdown-item").forEach((item) => {
    item.classList.toggle("active", String(item.dataset.fid) === String(app.selectedFavId));
  });
}

function positionFavDropdownMenu() {
  const button = $("favDropdownBtn");
  const menu = $("favDropdownMenu");
  if (!button || !menu || menu.classList.contains("hidden")) return;
  const rect = button.getBoundingClientRect();
  const margin = 8;
  const viewportGap = 12;
  const top = rect.bottom + margin;
  const maxHeight = Math.max(160, window.innerHeight - top - viewportGap);
  menu.style.left = `${Math.round(rect.left)}px`;
  menu.style.top = `${Math.round(top)}px`;
  menu.style.width = `${Math.round(rect.width)}px`;
  menu.style.maxHeight = `${Math.min(320, maxHeight)}px`;
}

function closeFavDropdown() {
  $("favDropdown").classList.remove("open");
  const menu = $("favDropdownMenu");
  menu.classList.add("hidden");
  menu.removeAttribute("style");
}

function toggleFavDropdown() {
  const root = $("favDropdown");
  const menu = $("favDropdownMenu");
  const open = menu.classList.contains("hidden");
  root.classList.toggle("open", open);
  menu.classList.toggle("hidden", !open);
  if (open) requestAnimationFrame(positionFavDropdownMenu);
}

function renderMetrics() {
  const items = currentItems();
  const history = historySet();
  $("metricTotal").textContent = items.length;
  $("metricDone").textContent = items.filter((x) => history.has(x.bvid)).length;
  $("metricSelected").textContent = app.selected.size;
}

function renderChart() {
  const chart = $("monthChart");
  const select = $("yearSelect");
  if (!chart || !select || !app.state) return;
  const items = app.state.favVideos || [];
  if (!items.length) {
    select.innerHTML = "";
    chart.innerHTML = `<div class="empty">暂无收藏夹数据</div>`;
    return;
  }
  const years = [...new Set(items.map((x) => x.year).filter(Boolean))].sort().reverse();
  if (!app.selectedYear || !years.includes(app.selectedYear)) app.selectedYear = years[0];
  const yearSignature = years.join("|");
  if (select.dataset.signature !== yearSignature) {
    select.innerHTML = years.map((year) => `<option value="${escapeAttr(year)}">${escapeHtml(year)}</option>`).join("");
    select.dataset.signature = yearSignature;
  }
  select.value = app.selectedYear;
  const history = historySet();
  const data = Array.from({ length: 12 }, (_, idx) => {
    const month = `${app.selectedYear}-${String(idx + 1).padStart(2, "0")}`;
    const monthItems = items.filter((item) => item.month === month);
    return {
      month,
      label: String(idx + 1).padStart(2, "0"),
      total: monthItems.length,
      done: monthItems.filter((item) => history.has(item.bvid)).length,
    };
  });
  const maxTotal = Math.max(1, ...data.map((x) => x.total));
  chart.innerHTML = data.map((x) => {
    const totalH = Math.max(3, Math.round((x.total / maxTotal) * 100));
    const doneH = x.total ? Math.round((x.done / maxTotal) * 100) : 0;
    const tip = `${x.month}: ${x.done}/${x.total}`;
    return `
      <div class="month-bar ${app.monthFilter === x.month ? "active" : ""}" data-month="${escapeAttr(x.month)}" title="${escapeAttr(tip)}">
        <span class="month-count">${x.total ? `${x.done}/${x.total}` : "0"}</span>
        <div class="bar-track">
          <span class="bar-total" style="height:${totalH}%"></span>
          <span class="bar-done" style="height:${doneH}%"></span>
        </div>
        <span class="month-label">${x.label}</span>
      </div>
    `;
  }).join("");
  chart.querySelectorAll(".month-bar").forEach((bar) => {
    bar.onclick = () => {
      const month = bar.dataset.month;
      app.monthFilter = app.monthFilter === month ? "" : month;
      app.mode = "fav";
      app.page = 1;
      $("modeFav").classList.add("active");
      $("modeManual").classList.remove("active");
      renderMetrics();
      renderChart();
      renderListIfNeeded(true);
    };
  });
}

function renderListIfNeeded(force = false) {
  const filtered = filteredItems();
  const totalPages = Math.max(1, Math.ceil(filtered.length / app.pageSize));
  app.page = Math.max(1, Math.min(app.page, totalPages));
  const start = (app.page - 1) * app.pageSize;
  const pageItems = filtered.slice(start, start + app.pageSize);
  const signature = JSON.stringify({
    mode: app.mode,
    page: app.page,
    duration: app.duration,
    undoneOnly: app.undoneOnly,
    groupByMonth: app.groupByMonth,
    monthFilter: app.monthFilter,
    search: app.search,
    selected: [...app.selected].sort(),
    history: [...historySet()].sort(),
    items: pageItems.map((x) => [x.bvid, x.title, x.cover, x.month, x.duration]),
  });
  if (!force && signature === app.listSignature) {
    $("pageInfo").textContent = `Page ${app.page} / ${totalPages}`;
    return;
  }
  app.listSignature = signature;
  renderList(pageItems, totalPages);
}

function renderList(pageItems, totalPages) {
  const list = $("videoList");
  const history = historySet();
  $("pageInfo").textContent = `Page ${app.page} / ${totalPages}`;

  if (!pageItems.length) {
    list.innerHTML = `<div class="empty">没有可显示的视频</div>`;
    return;
  }

  let lastMonth = "";
  const html = [];
  for (const item of pageItems) {
    if (app.mode === "fav" && app.groupByMonth && item.month !== lastMonth) {
      lastMonth = item.month;
      html.push(`<div class="month">${escapeHtml(lastMonth || "未分组")}</div>`);
    }
    const done = history.has(item.bvid);
    const selected = app.selected.has(item.bvid);
    const cover = proxyCover(item.cover || item.pic || "");
    html.push(`
      <article class="video-card ${done ? "done" : ""} ${selected ? "selected" : ""}" data-bvid="${escapeHtml(item.bvid)}">
        <input class="check" type="checkbox" ${selected ? "checked" : ""} />
        <div class="cover">${cover ? `<img loading="lazy" src="${escapeAttr(cover)}" alt="">` : ""}</div>
        <div class="info">
          <div class="title">${escapeHtml(item.title || item.bvid)}</div>
          <div class="meta">${escapeHtml(item.date || "")} · ${formatDuration(item.duration)} · ${escapeHtml(item.bvid)}</div>
        </div>
        <div class="badge ${done ? "done" : ""}">${done ? "已下" : "未下"}</div>
      </article>
    `);
  }
  list.innerHTML = html.join("");
  list.querySelectorAll(".video-card").forEach((card) => {
    const bvid = card.dataset.bvid;
    card.addEventListener("click", (event) => {
      if (event.target.classList.contains("check")) return;
      toggleSelect(bvid);
    });
    card.querySelector(".check").addEventListener("change", () => toggleSelect(bvid));
    card.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      navigator.clipboard?.writeText(bvid);
      toast(`已复制 ${bvid}`);
    });
  });
  list.querySelectorAll(".cover img").forEach((img) => {
    img.addEventListener("load", () => img.classList.add("loaded"));
    if (img.complete) img.classList.add("loaded");
  });
}

function renderDownload() {
  const d = app.state.download || {};
  $("downloadTitle").textContent = d.title || "等待任务";
  $("downloadStatus").textContent = d.status || "Ready";
  $("totalProgress").style.width = `${Math.round((d.total || 0) * 100)}%`;
  $("fileProgress").style.width = `${Math.round((d.file || 0) * 100)}%`;
}

function setInputValue(id, value) {
  const input = $(id);
  if (input && document.activeElement !== input) input.value = value || "";
}

function renderSettings() {
  const settings = app.state.settings || {};
  const isTestBuild = app.state.build?.flavor === "test";
  setInputValue("saveDir", $("saveDir")?.value || settings.downloadDir || "");
  setInputValue("settingDataDir", settings.dataDir || "");
  setInputValue("settingDownloadDir", settings.downloadDir || "");
  setInputValue("settingFfmpegPath", settings.ffmpegPath || "");
  setInputValue("settingFfprobePath", settings.ffprobePath || "");
  setInputValue("settingAria2Path", settings.aria2Path || "");
  setInputValue("settingEagleExportDir", settings.eagleExportDir || "");
  setInputValue("settingErrorLogPath", settings.errorLogPath || "");
  if ($("resetStateBtn")) $("resetStateBtn").classList.toggle("hidden", !isTestBuild);
}

function renderEagle() {
  const cfg = app.state.eagle || {};
  const task = app.state.eagleTask || {};
  const index = app.state.eagleIndex || {};
  const library = $("eagleLibrary");
  if (library && document.activeElement !== library) library.value = cfg.libraryDir || "";
  if (cfg.libraryDir && app.eagleFoldersLibrary !== cfg.libraryDir && !app.eagleFoldersLoading) {
    loadEagleFolders(cfg.libraryDir).catch((error) => console.warn(error));
  }
  renderEagleFolders(cfg.folderId || "");
  if ($("deleteAfterEagle")) $("deleteAfterEagle").checked = cfg.deleteAfterImport !== false;
  if ($("useDanmakuEagle")) $("useDanmakuEagle").checked = cfg.useDanmaku !== false;
  if ($("eagleSpeedMode")) $("eagleSpeedMode").value = cfg.speedMode || "\u5e73\u8861";
  const total = Number(task.total || 0);
  const done = Number(task.done || 0);
  const rawProgress = Number.isFinite(Number(task.percent)) ? Number(task.percent) : (total > 0 ? done / total : 0);
  const progress = Math.max(0, Math.min(1, rawProgress));
  const percent = Math.round(progress * 100);
  $("eagleProgress").style.width = `${percent}%`;
  if ($("eaglePercent")) $("eaglePercent").textContent = `${percent}%`;
  $("eagleTaskTitle").textContent = task.current || (task.running ? "正在处理 Eagle 任务" : "等待 Eagle 任务");
  $("eagleTaskStatus").textContent = task.status || "Idle";
  if ($("eagleProgressDetail")) $("eagleProgressDetail").textContent = total ? `${done}/${total}` : "0/0";
  const stats = task.stats || {};
  if ($("eagleTaskStats")) {
    $("eagleTaskStats").innerHTML = `
      <span>成功 ${Number(stats.success || 0)}</span>
      <span>失败 ${Number(stats.failed || 0)}</span>
      <span>跳过 ${Number(stats.skipped || 0)}</span>
    `;
  }
  if ($("eagleTaskErrors")) {
    const errors = (task.errors || []).slice(-3);
    $("eagleTaskErrors").innerHTML = errors.length
      ? errors.map((item) => `<div>${escapeHtml(item)}</div>`).join("")
      : "";
  }
  if ($("eaglePauseBtn")) $("eaglePauseBtn").textContent = task.paused ? "继续" : "暂停";
  if ($("eagleCancelBtn")) $("eagleCancelBtn").disabled = !task.running;
  if ($("eagleIndexStatus")) {
    $("eagleIndexStatus").textContent = index.count
      ? `Index: ${index.count} items · ${index.generatedAt || ""}`
      : "Index: not built";
  }
}

function renderDiagnostics() {
  const list = $("diagnosticsList");
  const summary = $("diagnosticsSummary");
  const btn = $("runDiagnosticsBtn");
  if (!list || !summary) return;
  if (btn) btn.textContent = app.diagnosticsLoading ? "检查中" : "运行";
  if (btn) btn.disabled = app.diagnosticsLoading;
  if (!app.diagnostics) return;
  summary.textContent = app.diagnostics.summary || "诊断完成";
  const items = app.diagnostics.items || [];
  list.innerHTML = items.map((item) => {
    const level = escapeAttr(item.level || "warn");
    const title = escapeHtml(item.title || "");
    const detail = escapeHtml(item.detail || "");
    const extra = escapeHtml(item.extra || "");
    const label = item.level === "ok" ? "正常" : item.level === "error" ? "处理" : "建议";
    return `
      <div class="diagnostic-item ${level}">
        <span class="status-dot"></span>
        <div>
          <div class="diagnostic-title"><strong>${title}</strong><em>${label}</em></div>
          <div class="diagnostic-detail">${detail}</div>
          ${extra ? `<div class="diagnostic-extra">${extra}</div>` : ""}
        </div>
      </div>
    `;
  }).join("");
}

async function runDiagnostics() {
  app.diagnosticsLoading = true;
  renderDiagnostics();
  try {
    app.diagnostics = await api("/api/diagnostics", { method: "POST", body: {} });
    toast(`诊断完成：${app.diagnostics.summary || ""}`);
  } catch (error) {
    toast(error.message);
  } finally {
    app.diagnosticsLoading = false;
    renderDiagnostics();
  }
}

function renderEagleFolders(selectedId = "") {
  const select = $("eagleFolder");
  if (!select) return;
  const current = selectedId || select.value || "";
  const options = [`<option value="">导入到 Eagle 默认位置</option>`]
    .concat((app.eagleFolders || []).map((item) => {
      const id = escapeAttr(item.id || "");
      const path = escapeHtml(item.path || item.name || item.id || "");
      return `<option value="${id}">${path}</option>`;
    }));
  select.innerHTML = options.join("");
  select.value = current;
}

async function loadEagleFolders(libraryDir) {
  if (!libraryDir) {
    app.eagleFolders = [];
    app.eagleFoldersLibrary = "";
    renderEagleFolders("");
    return;
  }
  app.eagleFoldersLoading = true;
  try {
    const result = await api("/api/eagle/folders", {
      method: "POST",
      body: { libraryDir },
    });
    app.eagleFolders = result.folders || [];
    app.eagleFoldersLibrary = libraryDir;
    renderEagleFolders(app.state?.eagle?.folderId || "");
  } finally {
    app.eagleFoldersLoading = false;
  }
}

function renderLogs() {
  const logs = app.state.logs || [];
  $("logs").innerHTML = logs.map((item) => `<div><span class="muted">[${escapeHtml(item.time)}]</span> ${escapeHtml(item.text)}</div>`).join("");
  $("logs").scrollTop = $("logs").scrollHeight;
}

function toggleSelect(bvid) {
  if (app.selected.has(bvid)) app.selected.delete(bvid);
  else app.selected.add(bvid);
  renderMetrics();
  renderListIfNeeded(true);
}

function selectedArray() {
  return [...app.selected];
}

async function refresh() {
  try {
    app.state = await api("/api/state");
    renderState();
  } catch (error) {
    console.error(error);
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("'", "&#39;");
}

function toast(message) {
  const line = document.createElement("div");
  line.textContent = message;
  line.style.cssText = "position:fixed;left:50%;bottom:28px;transform:translateX(-50%);padding:10px 16px;border-radius:999px;background:rgba(20,24,34,.92);border:1px solid rgba(255,255,255,.12);z-index:20";
  document.body.appendChild(line);
  setTimeout(() => line.remove(), 1800);
}

function showModal(html) {
  $("modalBody").innerHTML = html;
  $("modal").classList.remove("hidden");
}

function closeModal() {
  $("modal").classList.add("hidden");
  $("modalBody").innerHTML = "";
  if (app.pollingQr) {
    clearInterval(app.pollingQr);
    app.pollingQr = null;
  }
}

function openHelpGuide() {
  showModal(`
    <div class="help-doc">
      <div class="help-hero">
        <div>
          <div class="eyebrow">使用指南</div>
          <h2>BiliDownloader Studio 怎么用</h2>
          <p class="muted">这份指南覆盖下载、Eagle 导入、封面套图、历史记录、特殊链接、路径设置和常见问题。使用时可以随时点左上角 ? 打开。</p>
        </div>
        <div class="guide-actions">
          <button id="helpRunDiag" class="btn primary">先运行环境诊断</button>
          <button id="helpResetState" class="btn danger">恢复初始状态</button>
        </div>
      </div>

      <section>
        <h3>最快上手流程</h3>
        <ol>
          <li>点击左侧“扫码登录”，用 B站 App 扫码。</li>
          <li>在左侧选择收藏夹，点击“同步收藏夹”。</li>
          <li>在中间列表勾选要下载的视频，也可以点“全选当前列表”。</li>
          <li>右侧选择下载目录，点击“启动下载”。</li>
          <li>如果要整理到 Eagle，先打开 Eagle，选择 .library 库和目标文件夹，再点“导入已下载视频到 Eagle”。</li>
        </ol>
      </section>

      <section>
        <h3>首次使用要不要扫描 Eagle 库？</h3>
        <p>不需要。只用下载功能时完全不用设置 Eagle。下载后导入 Eagle 时，也只需要选择 Eagle 的 .library 目录和目标文件夹。</p>
        <p>“刷新 Eagle 库索引”不是首次必做项。只有在你要处理 Eagle 里已经存在的视频、批量修复旧封面、或者 Eagle 文件夹变化很多时，才需要刷新索引。</p>
      </section>

      <section>
        <h3>账号与环境诊断</h3>
        <ul>
          <li>扫码登录：用于读取你的收藏夹和下载需要登录权限的视频。</li>
          <li>环境诊断：检查 FFmpeg、FFprobe、Aria2、下载目录、Eagle API、Eagle 库路径和写入权限。</li>
          <li>FFmpeg / FFprobe：用于合并高清视频音频、抽帧生成封面。如果路径为空，程序会优先使用内置或系统路径。</li>
          <li>Aria2：可选加速下载器。不稳定时可以留空，程序会回退到内置下载方式。</li>
        </ul>
      </section>

      <section>
        <h3>同步收藏夹</h3>
        <ul>
          <li>登录后，左侧会显示你的收藏夹。</li>
          <li>选择一个收藏夹后点击“同步收藏夹”。同步只读取列表，不会自动下载。</li>
          <li>列表会显示标题、BV 号、封面、时长、收藏时间和是否已下载。</li>
          <li>同步速度会保持保守，不做激进并发，避免触发 B站风控。</li>
        </ul>
      </section>

      <section>
        <h3>筛选和选择视频</h3>
        <ul>
          <li>搜索框：按标题或 BV 号查找。</li>
          <li>时长筛选：按视频长度快速筛选。</li>
          <li>仅看未下载：只显示历史记录里还没下载过的视频。</li>
          <li>月份分布：点击柱状图月份，可以按收藏时间筛选。</li>
          <li>全选当前列表：只选择当前筛选条件下显示的视频。</li>
          <li>标记已下载 / 未下载：用于修正历史记录，不会删除本地视频。</li>
          <li>删除已选：只从当前列表移除，不等同于删除 B站收藏夹里的视频。</li>
        </ul>
      </section>

      <section>
        <h3>下载视频</h3>
        <ol>
          <li>先在中间列表勾选视频。</li>
          <li>右侧选择下载目录。</li>
          <li>选择清晰度。普通用户建议保持 1080。</li>
          <li>限速可以留空。担心网络或风控时，可以填写较保守的 KB/s 数值。</li>
          <li>点击“启动下载”。下载完成后会自动写入历史记录。</li>
        </ol>
        <p>“仅下载音频”适合只保存声音。“下载所有分 P”适合合集视频或多 P 视频。</p>
      </section>

      <section>
        <h3>特殊链接和外部来源</h3>
        <ul>
          <li>导入外部收藏夹：可以填收藏夹链接或 media_id。</li>
          <li>导入视频合集：可以填合集内任意视频链接或 BV 号。</li>
          <li>提取视频 / 特殊链接：适合普通视频链接、BV/av、短链、拜年祭或活动页。</li>
          <li>这些功能在左侧“更多数据来源与记录工具”里，不是新手必用。</li>
        </ul>
      </section>

      <section>
        <h3>历史记录与换电脑</h3>
        <ul>
          <li>下载完成后，程序会记录 BV 号、标题、路径、封面等信息。</li>
          <li>换电脑前，在旧电脑点“导出历史记录”。</li>
          <li>新电脑点“导入历史记录”，再同步收藏夹，旧视频会显示为已下载。</li>
          <li>这样可以避免重复下载以前保存过的视频。</li>
        </ul>
      </section>

      <section>
        <h3>测试版专用：恢复初始状态</h3>
        <ul>
          <li>会清空本软件的下载记录、收藏夹缓存、登录态、Eagle 索引、搜索缓存和路径设置。</li>
          <li>重置后会回到“刚安装、还没配置”的状态。</li>
          <li>这个功能不删除你的 B站收藏夹，也不删除 Eagle 库本身。</li>
          <li>执行前建议先停止正在运行的下载或 Eagle 任务。</li>
        </ul>
        <p>如果你只是想换账号，直接点“退出”就够了，不必重置。</p>
      </section>

      <section>
        <h3>Eagle 导入视频</h3>
        <ol>
          <li>先下载视频，并确认本地文件还存在。</li>
          <li>打开 Eagle。</li>
          <li>点击“选择 Eagle 库”，选择以 .library 结尾的 Eagle 库目录。</li>
          <li>选择导入目标文件夹。如果不选，会导入到 Eagle 默认位置。</li>
          <li>点击“导入已下载视频到 Eagle”。</li>
        </ol>
        <p>导入时会生成封面套图：上方尽量使用 B站原封面，下方从视频中抽取静帧。开启弹幕峰值时，会优先选择弹幕高峰附近的画面。</p>
      </section>

      <section>
        <h3>Eagle 高级选项</h3>
        <ul>
          <li>导入成功后删除本地视频：节省硬盘空间。担心误删时可以先关闭。</li>
          <li>根据弹幕峰值优化抽帧：有弹幕缓存时封面质量通常更好。</li>
          <li>速度模式：快速更省时，平衡推荐，高质量更慢但候选帧更多。</li>
          <li>强制重新生成已有封面：默认不要打开，除非你想重做所有封面。</li>
          <li>刷新 Eagle 库索引：只在修复 Eagle 里已有视频、库变化很大、或者匹配异常时使用。</li>
        </ul>
      </section>

      <section>
        <h3>修复 Eagle 文件夹封面</h3>
        <ul>
          <li>用于处理已经在 Eagle 库里的视频，不是普通导入流程必需。</li>
          <li>先选择 Eagle 库和目标文件夹，再点“修复选中文件夹封面”。</li>
          <li>默认跳过已经有自定义封面的视频。</li>
          <li>匹配不到 BV 时，会直接从本地视频抽帧生成套图，不会继续请求 B站封面和弹幕。</li>
        </ul>
      </section>

      <section>
        <h3>路径设置</h3>
        <ul>
          <li>程序数据目录：保存登录状态、下载历史、收藏夹缓存和设置。修改后需要重启。</li>
          <li>默认下载目录：视频保存位置。</li>
          <li>FFmpeg / FFprobe / Aria2：留空会使用内置或系统工具。</li>
          <li>Eagle 导出/缓存目录：保存封面套图、弹幕缓存等中间文件。</li>
          <li>错误日志文件：保存失败原因，排查问题时有用。</li>
        </ul>
      </section>

      <section>
        <h3>常见问题</h3>
        <dl>
          <dt>双击 exe 后没打开页面</dt>
          <dd>首次启动可能需要 10-20 秒。也可以手动访问 http://127.0.0.1:8765。</dd>
          <dt>看不到最新 UI</dt>
          <dd>关闭旧的 BiliDownloaderStudio.exe 后重新打开，或访问 http://127.0.0.1:8765/?v=2。</dd>
          <dt>下载后没有声音</dt>
          <dd>通常是 FFmpeg 合并失败。先运行环境诊断，确认 FFmpeg 和 FFprobe 可用。</dd>
          <dt>部分电脑 aria2 下载失败</dt>
          <dd>可以留空 Aria2 路径，程序会回退到内置下载方式。</dd>
          <dt>Eagle 导入失败</dt>
          <dd>确认 Eagle 已打开、选中的是 .library 目录、目标文件夹存在、本地视频文件没有被移动。</dd>
          <dt>Eagle 缩略图没有马上变化</dt>
          <dd>Eagle 可能缓存缩略图。切换文件夹、刷新 Eagle 或重启 Eagle 后再看。</dd>
          <dt>同步或搜索变慢</dt>
          <dd>程序会刻意控制请求频率，避免被 B站识别成异常爬取。不要短时间反复大批量同步。</dd>
        </dl>
      </section>
    </div>
  `);
  const diagBtn = $("helpRunDiag");
  if (diagBtn) {
    diagBtn.onclick = () => {
      closeModal();
      scrollIntoPanel("runDiagnosticsBtn");
      runDiagnostics();
    };
  }
  const resetBtn = $("helpResetState");
  if (resetBtn) {
    const isTestBuild = app.state?.build?.flavor === "test";
    resetBtn.classList.toggle("hidden", !isTestBuild);
    resetBtn.onclick = isTestBuild ? openResetConfirm : null;
  }
}

function openResetConfirm() {
  showModal(`
    <h2>恢复初始状态</h2>
    <p class="muted">这会清空本软件的下载记录、登录态、收藏夹缓存、Eagle 索引和设置，恢复到刚安装时的样子。</p>
    <p class="muted">请输入 <strong>RESET</strong> 继续。</p>
    <input id="modalInput" class="input" placeholder="输入 RESET" autofocus />
    <button id="modalOk" class="btn danger full">确认重置</button>
  `);
  $("modalOk").onclick = async () => {
    const value = $("modalInput").value.trim();
    if (value !== "RESET") {
      toast("请输入 RESET 才能确认重置");
      return;
    }
    try {
      const result = await api("/api/reset", { method: "POST", body: {} });
      closeModal();
      toast(result.message || "已恢复初始状态");
      setTimeout(() => location.reload(), 700);
    } catch (error) {
      toast(error.message);
    }
  };
}

async function promptAction(title, placeholder, action) {
  showModal(`
    <h2>${escapeHtml(title)}</h2>
    <input id="modalInput" class="input" placeholder="${escapeAttr(placeholder)}" autofocus />
    <button id="modalOk" class="btn primary full">确定</button>
  `);
  $("modalOk").onclick = async () => {
    const value = $("modalInput").value.trim();
    if (!value) return;
    try {
      await action(value);
      closeModal();
      await refresh();
    } catch (error) {
      toast(error.message);
    }
  };
}

function scrollIntoPanel(id) {
  const el = $(id);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
  el.classList.add("attention");
  setTimeout(() => el.classList.remove("attention"), 900);
}

function clickGuideTarget() {
  const guide = guideStatus();
  const target = $(guide.target);
  if (!target) return;
  scrollIntoPanel(guide.target);
  setTimeout(() => target.click(), 180);
}

async function pickDirTo(id) {
  const result = await api("/api/choose-dir", { method: "POST", body: {} });
  if (result.path && $(id)) $(id).value = result.path;
}

async function pickFileTo(id) {
  const result = await api("/api/choose-file", { method: "POST", body: {} });
  if (result.path && $(id)) $(id).value = result.path;
}

function settingsPayload() {
  return {
    dataDir: $("settingDataDir")?.value.trim() || "",
    downloadDir: $("settingDownloadDir")?.value.trim() || "",
    ffmpegPath: $("settingFfmpegPath")?.value.trim() || "",
    ffprobePath: $("settingFfprobePath")?.value.trim() || "",
    aria2Path: $("settingAria2Path")?.value.trim() || "",
    eagleExportDir: $("settingEagleExportDir")?.value.trim() || "",
    errorLogPath: $("settingErrorLogPath")?.value.trim() || "",
  };
}

async function saveSettings(showToast = true) {
  await api("/api/settings", { method: "POST", body: settingsPayload() });
  if (showToast) toast("路径设置已保存");
  await refresh();
}

function bindSettingsEvents() {
  if (app.settingsBound) return;
  app.settingsBound = true;
  $("pickDataDir").onclick = () => pickDirTo("settingDataDir");
  $("pickDownloadDir").onclick = () => pickDirTo("settingDownloadDir");
  $("pickFfmpegPath").onclick = () => pickFileTo("settingFfmpegPath");
  $("pickFfprobePath").onclick = () => pickFileTo("settingFfprobePath");
  $("pickAria2Path").onclick = () => pickFileTo("settingAria2Path");
  $("pickEagleExportDir").onclick = () => pickDirTo("settingEagleExportDir");
  $("pickErrorLogPath").onclick = () => pickFileTo("settingErrorLogPath");
  $("saveSettingsBtn").onclick = () => saveSettings(true).catch((error) => toast(error.message));
  $("resetStateBtn").onclick = openResetConfirm;
  if ($("runDiagnosticsBtn")) $("runDiagnosticsBtn").onclick = runDiagnostics;
  if ($("guidePrimaryBtn")) $("guidePrimaryBtn").onclick = clickGuideTarget;
  if ($("guideHelpBtn")) $("guideHelpBtn").onclick = () => {
    openHelpGuide();
  };
  if ($("helpBtn")) $("helpBtn").onclick = openHelpGuide;
}

function bindEvents() {
  bindSettingsEvents();
  $("favDropdownBtn").onclick = (event) => {
    event.stopPropagation();
    toggleFavDropdown();
  };
  $("favDropdownMenu").onclick = (event) => event.stopPropagation();
  document.addEventListener("click", (event) => {
    if (!$("favDropdown").contains(event.target)) closeFavDropdown();
  });
  window.addEventListener("resize", positionFavDropdownMenu);
  document.querySelector(".rail")?.addEventListener("scroll", positionFavDropdownMenu, { passive: true });
  $("modeFav").onclick = () => {
    app.mode = "fav";
    app.page = 1;
    $("modeFav").classList.add("active");
    $("modeManual").classList.remove("active");
    renderMetrics();
    renderChart();
    renderListIfNeeded(true);
  };
  $("modeManual").onclick = () => {
    app.mode = "manual";
    app.page = 1;
    $("modeManual").classList.add("active");
    $("modeFav").classList.remove("active");
    app.monthFilter = "";
    renderMetrics();
    renderChart();
    renderListIfNeeded(true);
  };
  $("searchInput").oninput = (e) => {
    app.search = e.target.value;
    app.page = 1;
    renderMetrics();
    renderListIfNeeded(true);
  };
  $("durationFilter").onchange = (e) => {
    app.duration = e.target.value;
    app.page = 1;
    renderMetrics();
    renderListIfNeeded(true);
  };
  $("undoneOnly").onchange = (e) => {
    app.undoneOnly = e.target.checked;
    app.page = 1;
    renderMetrics();
    renderListIfNeeded(true);
  };
  $("groupByMonth").onchange = (e) => {
    app.groupByMonth = e.target.checked;
    renderListIfNeeded(true);
  };
  $("prevPage").onclick = () => {
    app.page -= 1;
    renderListIfNeeded(true);
  };
  $("nextPage").onclick = () => {
    app.page += 1;
    renderListIfNeeded(true);
  };
  $("selectAllBtn").onclick = () => {
    filteredItems().forEach((item) => app.selected.add(item.bvid));
    renderMetrics();
    renderListIfNeeded(true);
  };
  $("clearSelectBtn").onclick = () => {
    app.selected.clear();
    renderMetrics();
    renderListIfNeeded(true);
  };
  $("yearSelect").onchange = (event) => {
    app.selectedYear = event.target.value;
    app.monthFilter = "";
    app.page = 1;
    renderChart();
    renderListIfNeeded(true);
  };
  $("markDoneBtn").onclick = async () => {
    await api("/api/mark", { method: "POST", body: { bvids: selectedArray(), done: true } });
    await refresh();
  };
  $("markUndoneBtn").onclick = async () => {
    await api("/api/mark", { method: "POST", body: { bvids: selectedArray(), done: false } });
    await refresh();
  };
  $("deleteBtn").onclick = async () => {
    if (!app.selected.size || !confirm("确定删除已选项目？")) return;
    await api("/api/delete", { method: "POST", body: { bvids: selectedArray() } });
    app.selected.clear();
    await refresh();
  };
  $("syncBtn").onclick = async () => {
    const fid = app.selectedFavId;
    if (!fid) return toast("请先选择收藏夹");
    await api("/api/sync", { method: "POST", body: { fid } });
    toast("已开始同步");
  };
  $("importFavBtn").onclick = () => promptAction("导入外部收藏夹", "收藏夹链接或 media_id", async (value) => {
    await api("/api/import/fav", { method: "POST", body: { value } });
  });
  $("seasonBtn").onclick = () => promptAction("导入视频合集", "合集内任意视频链接或 BV 号", async (value) => {
    await api("/api/import/season", { method: "POST", body: { value } });
  });
  $("extractBtn").onclick = () => promptAction("提取视频/特殊链接", "普通视频、av/BV、短链、拜年祭/活动页链接", async (value) => {
    await api("/api/manual/extract", { method: "POST", body: { value } });
  });
  $("importHistoryBtn").onclick = async () => {
    try {
      const picked = await api("/api/choose-file", { method: "POST", body: {} });
      if (!picked.path) return;
      const result = await api("/api/history/import", { method: "POST", body: { path: picked.path } });
      toast(`导入完成：新增 ${result.added} 条，总计 ${result.total} 条`);
      await refresh();
    } catch (error) {
      toast(error.message);
    }
  };
  $("exportHistoryBtn").onclick = async () => {
    try {
      const picked = await api("/api/choose-dir", { method: "POST", body: {} });
      if (!picked.path) return;
      const result = await api("/api/history/export", { method: "POST", body: { path: picked.path } });
      toast(`已导出 ${result.count} 条记录`);
    } catch (error) {
      toast(error.message);
    }
  };
  $("chooseDirBtn").onclick = async () => {
    const result = await api("/api/choose-dir", { method: "POST", body: {} });
    if (result.path) {
      $("saveDir").value = result.path;
      $("settingDownloadDir").value = result.path;
      await saveSettings(false);
    }
  };
  $("chooseEagleBtn").onclick = async () => {
    try {
      const result = await api("/api/choose-dir", { method: "POST", body: {} });
      if (!result.path) return;
      $("eagleLibrary").value = result.path;
      await loadEagleFolders(result.path);
      await api("/api/eagle/config", {
        method: "POST",
        body: {
          libraryDir: result.path,
          folderId: $("eagleFolder").value,
          speedMode: $("eagleSpeedMode").value,
          deleteAfterImport: $("deleteAfterEagle").checked,
          useDanmaku: $("useDanmakuEagle").checked,
          force: $("forceEagleRebuild").checked,
        },
      });
      await refresh();
    } catch (error) {
      toast(error.message);
    }
  };
  $("startBtn").onclick = async () => {
    try {
      if (!app.selected.size) {
        toast("请先在中间列表勾选要下载的视频");
        scrollIntoPanel("videoList");
        return;
      }
      if (!$("saveDir").value.trim()) {
        toast("请先选择下载目录");
        scrollIntoPanel("chooseDirBtn");
        return;
      }
      await api("/api/download/start", {
        method: "POST",
        body: {
          bvids: selectedArray(),
          saveDir: $("saveDir").value.trim(),
          quality: $("quality").value,
          speed: $("speed").value,
          audioOnly: $("audioOnly").checked,
          allParts: $("allParts").checked,
        },
      });
      toast("下载已启动");
    } catch (error) {
      toast(error.message);
    }
  };
  $("eagleImportBtn").onclick = async () => {
    try {
      if (!$("eagleLibrary").value.trim()) {
        toast("请先选择 Eagle 的 .library 库目录");
        scrollIntoPanel("chooseEagleBtn");
        return;
      }
      const result = await api("/api/eagle/import", {
        method: "POST",
        body: {
          bvids: selectedArray(),
          libraryDir: $("eagleLibrary").value.trim(),
          folderId: $("eagleFolder").value,
          speedMode: $("eagleSpeedMode").value,
          deleteAfterImport: $("deleteAfterEagle").checked,
          useDanmaku: $("useDanmakuEagle").checked,
        },
      });
      toast(`Eagle \u5bfc\u5165\u5df2\u542f\u52a8\uff1a${result.total} \u4e2a\u89c6\u9891`);
      await refresh();
    } catch (error) {
      toast(error.message);
    }
  };
  $("eagleFolderThumbBtn").onclick = async () => {
    try {
      const folderId = $("eagleFolder").value;
      if (!folderId) {
        toast("\u8bf7\u5148\u9009\u62e9 Eagle \u6587\u4ef6\u5939");
        return;
      }
      const result = await api("/api/eagle/folder-thumbnails", {
        method: "POST",
        body: {
          libraryDir: $("eagleLibrary").value.trim(),
          folderId,
          speedMode: $("eagleSpeedMode").value,
          useDanmaku: $("useDanmakuEagle").checked,
          force: $("forceEagleRebuild").checked,
        },
      });
      toast(`\u6587\u4ef6\u5939\u5c01\u9762\u4fee\u590d\u5df2\u542f\u52a8\uff1a${result.total} \u4e2a\u89c6\u9891`);
      await refresh();
    } catch (error) {
      toast(error.message);
    }
  };
  $("eaglePauseBtn").onclick = async () => {
    const paused = !(app.state.eagleTask || {}).paused;
    await api("/api/eagle/pause", { method: "POST", body: { paused } });
    await refresh();
  };
  $("eagleCancelBtn").onclick = async () => {
    await api("/api/eagle/cancel", { method: "POST", body: {} });
    await refresh();
  };
  $("refreshEagleIndexBtn").onclick = async () => {
    try {
      const result = await api("/api/eagle/index/refresh", {
        method: "POST",
        body: { libraryDir: $("eagleLibrary").value.trim() },
      });
      toast(`Eagle 索引已刷新：${result.index.count} 项`);
      await refresh();
    } catch (error) {
      toast(error.message);
    }
  };
  $("openEagleBatchBtn").onclick = async () => {
    try {
      await api("/api/eagle/batch/open", { method: "POST", body: {} });
      toast("Eagle 批处理器已打开");
    } catch (error) {
      toast(error.message);
    }
  };
  $("deleteAfterEagle").onchange = () => api("/api/eagle/config", {
    method: "POST",
    body: {
      libraryDir: $("eagleLibrary").value.trim(),
      folderId: $("eagleFolder").value,
      speedMode: $("eagleSpeedMode").value,
      deleteAfterImport: $("deleteAfterEagle").checked,
      useDanmaku: $("useDanmakuEagle").checked,
    },
  }).then(refresh).catch((error) => toast(error.message));
  $("useDanmakuEagle").onchange = () => api("/api/eagle/config", {
    method: "POST",
    body: {
      libraryDir: $("eagleLibrary").value.trim(),
      folderId: $("eagleFolder").value,
      speedMode: $("eagleSpeedMode").value,
      deleteAfterImport: $("deleteAfterEagle").checked,
      useDanmaku: $("useDanmakuEagle").checked,
    },
  }).then(refresh).catch((error) => toast(error.message));
  $("eagleSpeedMode").onchange = () => api("/api/eagle/config", {
    method: "POST",
    body: {
      libraryDir: $("eagleLibrary").value.trim(),
      folderId: $("eagleFolder").value,
      speedMode: $("eagleSpeedMode").value,
      deleteAfterImport: $("deleteAfterEagle").checked,
      useDanmaku: $("useDanmakuEagle").checked,
    },
  }).then(refresh).catch((error) => toast(error.message));
  $("eagleFolder").onchange = () => api("/api/eagle/config", {
    method: "POST",
    body: {
      libraryDir: $("eagleLibrary").value.trim(),
      folderId: $("eagleFolder").value,
      speedMode: $("eagleSpeedMode").value,
      deleteAfterImport: $("deleteAfterEagle").checked,
      useDanmaku: $("useDanmakuEagle").checked,
    },
  }).then(refresh).catch((error) => toast(error.message));
  $("pauseBtn").onclick = () => api("/api/download/pause", { method: "POST", body: {} }).then(refresh);
  $("cancelBtn").onclick = () => api("/api/download/cancel", { method: "POST", body: {} }).then(refresh);
  $("loginBtn").onclick = async () => {
    const data = await api("/api/login/qr", { method: "POST", body: {} });
    showModal(`<h2>扫码登录</h2><p class="muted">使用哔哩哔哩 App 扫码</p><img class="qr" src="${data.image}" />`);
    app.pollingQr = setInterval(async () => {
      const result = await api(`/api/login/poll?key=${encodeURIComponent(data.key)}`);
      if (result.code === 0) {
        closeModal();
        setTimeout(refresh, 900);
      }
    }, 2200);
  };
  $("logoutBtn").onclick = () => api("/api/logout", { method: "POST", body: {} }).then(refresh);
  $("modalClose").onclick = closeModal;
  $("modal").onclick = (event) => {
    if (event.target.id === "modal") closeModal();
  };
  document.addEventListener("keydown", (event) => {
    if (event.ctrlKey && event.key.toLowerCase() === "a" && document.activeElement.tagName !== "INPUT") {
      event.preventDefault();
      filteredItems().forEach((item) => app.selected.add(item.bvid));
      renderMetrics();
      renderListIfNeeded(true);
    }
    if (event.ctrlKey && event.key.toLowerCase() === "f") {
      event.preventDefault();
      $("searchInput").focus();
    }
    if (event.key === "Escape") {
      app.selected.clear();
      renderMetrics();
      renderListIfNeeded(true);
    }
  });
}

bindEvents();
refresh();
setInterval(refresh, 1400);

