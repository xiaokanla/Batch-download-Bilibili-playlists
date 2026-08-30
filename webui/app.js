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
  refreshing: false,
  tagGraph: {
    dataSignature: "",
    zoom: 1,
    panX: 0,
    panY: 0,
  },
  eagleFolders: [],
  eagleFoldersLibrary: "",
  eagleFoldersLoading: false,
  diagnostics: null,
  diagnosticsLoading: false,
  contextMenuBvid: "",
  creatorCandidates: [],
  selectedCreatorMid: "",
  creatorSearchController: null,
  creatorSearchRequestId: 0,
  creatorSearchRunning: false,
  tagFilter: "",
  tagFilterBvids: null,
};

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function clampTagGraphPan() {
  const size = 560;
  const zoom = clampNumber(Number(app.tagGraph.zoom) || 1, 0.65, 2.5);
  app.tagGraph.zoom = zoom;
  if (zoom <= 1) {
    const offset = (size - size * zoom) / 2;
    app.tagGraph.panX = offset;
    app.tagGraph.panY = offset;
    return;
  }
  const minPan = size - size * zoom;
  app.tagGraph.panX = clampNumber(Number(app.tagGraph.panX) || 0, minPan, 0);
  app.tagGraph.panY = clampNumber(Number(app.tagGraph.panY) || 0, minPan, 0);
}

function initTagGraphCanvas() {
  const canvas = $("tagCloudWords");
  if (!canvas) return;
  const savedWidth = Number(localStorage.getItem("bili-tag-graph-width"));
  const savedHeight = Number(localStorage.getItem("bili-tag-graph-height"));
  if (Number.isFinite(savedWidth) && savedWidth >= 260) canvas.style.width = `${Math.round(savedWidth)}px`;
  if (Number.isFinite(savedHeight) && savedHeight >= 320) canvas.style.height = `${Math.round(savedHeight)}px`;

  const rememberSize = () => {
    const rect = canvas.getBoundingClientRect();
    const parentWidth = canvas.parentElement?.getBoundingClientRect().width || rect.width;
    if (rect.width > parentWidth + 1) {
      canvas.style.width = `${Math.max(260, Math.floor(parentWidth))}px`;
    }
    localStorage.setItem("bili-tag-graph-width", String(Math.round(canvas.getBoundingClientRect().width)));
    localStorage.setItem("bili-tag-graph-height", String(Math.round(canvas.getBoundingClientRect().height)));
  };
  if (typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(rememberSize);
    observer.observe(canvas);
    if (canvas.parentElement) observer.observe(canvas.parentElement);
  }
  window.addEventListener("resize", rememberSize);
  rememberSize();
}

function initResizableLayout() {
  const shell = document.querySelector(".shell");
  const railResizer = $("railResizer");
  const inspectorResizer = $("inspectorResizer");
  if (!shell || !railResizer || !inspectorResizer) return;

  const savedRail = Number(localStorage.getItem("bili-layout-rail-width"));
  const savedInspector = Number(localStorage.getItem("bili-layout-inspector-width"));
  if (Number.isFinite(savedRail)) {
    shell.style.setProperty("--rail-width", `${clampNumber(savedRail, 220, 420)}px`);
  }
  if (Number.isFinite(savedInspector)) {
    shell.style.setProperty("--inspector-width", `${clampNumber(savedInspector, 300, 620)}px`);
  }

  const startResize = (resizer, type, event) => {
    if (window.matchMedia("(max-width: 1180px)").matches) return;
    event.preventDefault();
    const startX = event.clientX;
    const startRail = parseFloat(getComputedStyle(shell).getPropertyValue("--rail-width")) || 292;
    const startInspector = parseFloat(getComputedStyle(shell).getPropertyValue("--inspector-width")) || 420;
    resizer.classList.add("dragging");
    document.body.classList.add("is-resizing");
    resizer.setPointerCapture?.(event.pointerId);

    const move = (moveEvent) => {
      const delta = moveEvent.clientX - startX;
      if (type === "rail") {
        const width = clampNumber(startRail + delta, 220, 420);
        shell.style.setProperty("--rail-width", `${Math.round(width)}px`);
        localStorage.setItem("bili-layout-rail-width", String(Math.round(width)));
        railResizer.setAttribute("aria-valuenow", String(Math.round(width)));
      } else {
        const width = clampNumber(startInspector - delta, 300, 620);
        shell.style.setProperty("--inspector-width", `${Math.round(width)}px`);
        localStorage.setItem("bili-layout-inspector-width", String(Math.round(width)));
        inspectorResizer.setAttribute("aria-valuenow", String(Math.round(width)));
      }
    };
    const stop = () => {
      resizer.classList.remove("dragging");
      document.body.classList.remove("is-resizing");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
    window.addEventListener("pointercancel", stop, { once: true });
  };

  railResizer.setAttribute("aria-valuemin", "220");
  railResizer.setAttribute("aria-valuemax", "420");
  railResizer.setAttribute("aria-valuenow", String(Math.round(parseFloat(getComputedStyle(shell).getPropertyValue("--rail-width")) || 292)));
  inspectorResizer.setAttribute("aria-valuemin", "300");
  inspectorResizer.setAttribute("aria-valuemax", "620");
  inspectorResizer.setAttribute("aria-valuenow", String(Math.round(parseFloat(getComputedStyle(shell).getPropertyValue("--inspector-width")) || 420)));
  railResizer.addEventListener("pointerdown", (event) => startResize(railResizer, "rail", event));
  inspectorResizer.addEventListener("pointerdown", (event) => startResize(inspectorResizer, "inspector", event));
  railResizer.addEventListener("dblclick", () => {
    shell.style.setProperty("--rail-width", "292px");
    localStorage.removeItem("bili-layout-rail-width");
    railResizer.setAttribute("aria-valuenow", "292");
  });
  inspectorResizer.addEventListener("dblclick", () => {
    shell.style.setProperty("--inspector-width", "420px");
    localStorage.removeItem("bili-layout-inspector-width");
    inspectorResizer.setAttribute("aria-valuenow", "420");
  });
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    method: options.method || "GET",
    headers: { "Content-Type": "application/json" },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: options.signal,
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
  if (app.mode === "creator") return app.state.creatorVideos || [];
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
    if (app.tagFilterBvids && !app.tagFilterBvids.has(item.bvid)) return false;
    if (app.mode !== "manual" && app.monthFilter && item.month !== app.monthFilter) return false;
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

  renderModeLayout();
  renderFavSelect();
  renderCreatorSource();
  renderMetrics();
  renderChart();
  renderTagCloud();
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
  const hasVideos = Boolean((app.state?.favVideos || []).length || (app.state?.manualVideos || []).length || (app.state?.creatorVideos || []).length);
  const hasSelected = app.selected.size > 0;
  const hasDownloadDir = Boolean(($("saveDir")?.value || app.state?.settings?.downloadDir || "").trim());
  const hasDownloadedLocalVideos = Object.values(app.state?.downloadRecords || {}).some((record) => record.path);
  const eagleLibrary = Boolean(($("eagleLibrary")?.value || app.state?.eagle?.libraryDir || "").trim());
  if (app.mode === "creator") {
    const hasCreator = Boolean(app.selectedCreatorMid);
    const hasCreatorVideos = Boolean((app.state?.creatorVideos || []).length);
    if (!hasCreator) {
      return {
        step: 2,
        title: "查找要下载投稿的账号",
        description: "输入账号名称、UID 或主页链接，选择正确账号后再获取投稿列表。",
        action: "查找账号",
        target: "creatorSearchBtn",
        help: "账号检索不会自动抓取投稿。",
      };
    }
    if (!hasCreatorVideos) {
      return {
        step: 2,
        title: "获取账号投稿列表",
        description: "获取公开投稿后，可用顶部搜索栏筛选“角色 PV”等标题或 BV 号。",
        action: "获取投稿列表",
        target: "creatorSyncBtn",
        help: "分页获取采用低频串行模式，数量很多时会更久。",
      };
    }
  }
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

function setMode(mode) {
  app.mode = mode;
  app.page = 1;
  app.monthFilter = "";
  clearTagFilter();
  ["fav", "creator", "manual"].forEach((name) => {
    $(`mode${name[0].toUpperCase()}${name.slice(1)}`).classList.toggle("active", name === mode);
  });
  renderModeLayout();
  renderMetrics();
  renderChart();
  renderTagCloud();
  renderListIfNeeded(true);
  renderGuide();
}

function renderModeLayout() {
  const creatorMode = app.mode === "creator";
  $("favSourcePanel").classList.toggle("hidden", creatorMode);
  $("creatorSourcePanel").classList.toggle("hidden", !creatorMode);
  $("workbenchTitle").textContent = creatorMode ? "账号投稿下载" : app.mode === "manual" ? "手动视频下载" : "收藏夹下载工作台";
  $("workbenchSubtitle").textContent = creatorMode
    ? "先选择账号，获取公开投稿后可用顶部搜索筛选。"
    : app.mode === "manual"
      ? "通过视频链接、BV 号或合集添加要下载的视频。"
      : "按页面上的步骤操作，不需要了解技术细节。";
  $("searchInput").placeholder = creatorMode ? "筛选当前账号投稿的标题 / BV 号" : "搜索标题 / BV 号";
}

function renderCreatorSource() {
  const task = app.state?.creatorSync || {};
  const select = $("creatorResults");
  const syncBtn = $("creatorSyncBtn");
  $("creatorSyncProgress").style.width = `${Math.round((task.progress || 0) * 100)}%`;
  if (!app.creatorCandidates.some((item) => String(item.mid) === String(app.selectedCreatorMid))) {
    app.selectedCreatorMid = "";
  }
  if (select.dataset.signature !== JSON.stringify(app.creatorCandidates.map((item) => [item.mid, item.name, item.fans]))) {
    const options = app.creatorCandidates.map((item) => {
      const fans = Number(item.fans || 0);
      const suffix = fans ? ` · ${fans.toLocaleString()} 粉丝` : "";
      return `<option value="${escapeAttr(item.mid)}">${escapeHtml(item.name)}${escapeHtml(suffix)} · UID ${escapeHtml(item.mid)}</option>`;
    });
    select.innerHTML = `<option value="">请选择账号</option>${options.join("")}`;
    select.dataset.signature = JSON.stringify(app.creatorCandidates.map((item) => [item.mid, item.name, item.fans]));
  }
  select.disabled = !app.creatorCandidates.length || Boolean(task.running);
  select.value = app.selectedCreatorMid;
  syncBtn.disabled = !app.selectedCreatorMid || Boolean(task.running);
  $("creatorSearchBtn").disabled = Boolean(task.running) || app.creatorSearchRunning;
  $("creatorSearchBtn").textContent = app.creatorSearchRunning ? "检索中..." : "查找账号";
  const source = app.state?.creatorSource || {};
  if (task.running) {
    $("creatorSyncHint").textContent = `正在低频获取投稿：${Math.round((task.progress || 0) * 100)}%`;
  } else if (source.mid && (app.state?.creatorVideos || []).length) {
    $("creatorSyncHint").textContent = `当前列表：${source.name || source.mid} · ${(app.state.creatorVideos || []).length} 个视频，可用顶部搜索栏筛选`;
  } else {
    $("creatorSyncHint").textContent = "检索账号后，选择一个候选账号，再获取公开投稿。";
  }
}

function clearTagFilter() {
  app.tagFilter = "";
  app.tagFilterBvids = null;
}

function tagCloudSourceLabel() {
  if (app.mode === "creator") return "账号投稿";
  if (app.mode === "manual") return "手动列表";
  return "收藏夹";
}

function availableTagMonths() {
  return [...new Set(currentItems()
    .map((item) => String(item.month || ""))
    .filter((month) => /^\d{4}-\d{2}$/.test(month)))]
    .sort()
    .reverse();
}

function renderTagMonthOptions() {
  const select = $("tagMonth");
  const months = availableTagMonths();
  const current = select.value;
  const signature = months.join("|");
  if (select.dataset.signature === signature) {
    select.classList.toggle("hidden", $("tagRange").value !== "month");
    return;
  }
  select.innerHTML = months.length
    ? months.map((month) => `<option value="${escapeAttr(month)}">${escapeHtml(month)}</option>`).join("")
    : `<option value="">暂无可选月份</option>`;
  select.dataset.signature = signature;
  if (months.includes(current)) select.value = current;
  select.classList.toggle("hidden", $("tagRange").value !== "month");
}

function renderTagCloud() {
  const task = app.state?.tagTask || {};
  const cloud = app.state?.tagCloud || {};
  const words = $("tagCloudWords");
  if (!words) return;

  renderTagMonthOptions();
  $("tagCloudTitle").textContent = `${tagCloudSourceLabel()}标签关系图`;
  const running = Boolean(task.running);
  const range = $("tagRange").value;
  const month = $("tagMonth").value;
  const downloadedOnly = $("tagDownloadedOnly").checked;
  const matchesCloud = cloud.source === app.mode
    && cloud.range === range
    && Boolean(cloud.downloadedOnly) === downloadedOnly
    && (range !== "month" || cloud.month === month);
  const progress = Math.max(0, Math.min(1, Number(task.progress || 0)));
  $("tagCloudProgress").style.width = `${Math.round(progress * 100)}%`;
  $("generateTagCloudBtn").disabled = running || !currentItems().length;
  $("cancelTagCloudBtn").classList.toggle("hidden", !running);
  $("clearTagFilterBtn").classList.toggle("hidden", !app.tagFilter);

  if (running) {
    $("tagCloudStatus").textContent = `${task.status || "正在读取标签"} · ${task.done || 0}/${task.total || 0} · 缓存 ${task.cached || 0} · 失败 ${task.failed || 0}`;
  } else if (matchesCloud && cloud.tags?.length) {
    const scope = cloud.range === "month" ? (cloud.month || "指定月份") : ({
      "3m": "近 3 个月",
      "6m": "近 6 个月",
      "12m": "近 1 年",
    }[cloud.range] || "当前范围");
    $("tagCloudStatus").textContent = `${scope} · ${cloud.itemsWithTags || 0}/${cloud.items || 0} 个视频已有标签 · ${cloud.relationCount || 0} 条关联${cloud.downloadedOnly ? " · 仅已下载" : ""}`;
  } else if (task.status && task.status !== "等待生成词云") {
    $("tagCloudStatus").textContent = task.status;
  } else {
    $("tagCloudStatus").textContent = currentItems().length ? "手动生成；标签和关联会缓存在本地。" : "请先加载视频列表。";
  }

  // Keep the current graph alive while tags are being fetched. Rebuilding it
  // on every progress poll would restart all node animations and lose pan/zoom.
  if (running && words.querySelector(".tag-graph-svg")) return;

  if (!matchesCloud || !cloud.tags?.length) {
    words.innerHTML = `<div class="muted">标签会缓存到本地，生成后显示标签之间的关联。</div>`;
    return;
  }

  const graphSignature = JSON.stringify({
    source: cloud.source,
    range: cloud.range,
    month: cloud.month,
    downloadedOnly: cloud.downloadedOnly,
    updatedAt: cloud.updatedAt,
    tags: cloud.tags,
    graph: cloud.graph,
    tagBvids: cloud.tagBvids,
  });
  if (words.dataset.graphSignature !== graphSignature) {
    renderTagRelationGraph(words, cloud, graphSignature);
  } else {
    updateTagGraphHighlight(words, app.tagFilter);
  }
}

function renderTagRelationGraph(container, cloud, graphSignature = "") {
  const graph = cloud.graph || {};
  const fallback = buildTagGraphFallback(cloud);
  const nodes = (graph.nodes?.length ? graph.nodes : fallback.nodes).slice(0, 24);
  const edges = graph.edges?.length ? graph.edges : fallback.edges;
  if (!nodes.length) {
    container.innerHTML = `<div class="muted">暂无足够的标签数据。</div>`;
    return;
  }
  if (app.tagGraph.dataSignature !== graphSignature) {
    app.tagGraph.dataSignature = graphSignature;
    app.tagGraph.zoom = 1;
    app.tagGraph.panX = 0;
    app.tagGraph.panY = 0;
  }
  clampTagGraphPan();

  const width = 560;
  const height = 560;
  const centerX = width / 2;
  const centerY = height / 2;
  const maxCount = Math.max(1, ...nodes.map((node) => Number(node.count || 0)));
  const nodeByName = new Map(nodes.map((node) => [node.name, node]));
  const degree = new Map(nodes.map((node) => [node.name, 0]));
  edges.forEach((edge) => {
    if (nodeByName.has(edge.source) && nodeByName.has(edge.target)) {
      degree.set(edge.source, degree.get(edge.source) + 1);
      degree.set(edge.target, degree.get(edge.target) + 1);
    }
  });

  const sortedNodes = [...nodes].sort((a, b) => {
    const degreeDiff = degree.get(b.name) - degree.get(a.name);
    return degreeDiff || Number(b.count || 0) - Number(a.count || 0);
  });
  const positions = new Map();
  sortedNodes.forEach((node, index) => {
    if (index === 0) {
      positions.set(node.name, { x: centerX, y: centerY, ring: 0 });
      return;
    }
    const ring = index <= 6 ? 1 : index <= 14 ? 2 : 3;
    const ringCount = ring === 1 ? 6 : ring === 2 ? 8 : Math.max(1, sortedNodes.length - 14);
    const ringIndex = ring === 1 ? index - 1 : ring === 2 ? index - 7 : index - 15;
    const radius = ring === 1 ? 94 : ring === 2 ? 174 : 228;
    const angle = (Math.PI * 2 * ringIndex / ringCount) - Math.PI / 2 + (ring % 2 ? 0 : Math.PI / ringCount);
    positions.set(node.name, {
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius,
      ring,
    });
  });

  const colorFor = (name) => {
    let hash = 0;
    for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) % 360;
    return `hsl(${(hash + 185) % 360} 78% 68%)`;
  };
  const escapeSvg = (value) => escapeHtml(value).replaceAll("'", "&apos;");
  const validEdges = edges.filter((edge) => positions.has(edge.source) && positions.has(edge.target));
  const maxEdge = Math.max(1, ...validEdges.map((edge) => Number(edge.count || 0)));
  const activeTag = app.tagFilter;

  const edgeHtml = validEdges.map((edge) => {
    const source = positions.get(edge.source);
    const target = positions.get(edge.target);
    const connected = !activeTag || edge.source === activeTag || edge.target === activeTag;
    const widthValue = (0.8 + Number(edge.count || 0) / maxEdge * 2.8).toFixed(2);
    return `<line class="tag-edge${connected ? "" : " dim"}" data-source="${escapeAttr(edge.source)}" data-target="${escapeAttr(edge.target)}" x1="${source.x.toFixed(1)}" y1="${source.y.toFixed(1)}" x2="${target.x.toFixed(1)}" y2="${target.y.toFixed(1)}" stroke-width="${widthValue}" />`;
  }).join("");

  const nodeHtml = sortedNodes.map((node, index) => {
    const position = positions.get(node.name);
    const ratio = Number(node.count || 0) / maxCount;
    const radius = 9 + ratio * 12 + Math.min(4, degree.get(node.name) * 0.35);
    const selected = activeTag === node.name;
    const fill = colorFor(node.name);
    const labelSize = Math.max(11, Math.min(16, 11 + ratio * 5));
    const floatDelay = `${-((index % 7) * 0.65).toFixed(2)}s`;
    const floatDuration = `${(5.2 + (index % 4) * 0.75).toFixed(2)}s`;
    return `
      <g class="tag-node${selected ? " active" : ""}" data-tag="${escapeAttr(node.name)}" tabindex="0" role="button" aria-label="${escapeAttr(`${node.name}，${node.count} 个视频`)}">
        <g class="tag-node-float" style="--float-delay:${floatDelay};--float-duration:${floatDuration}">
          <circle cx="${position.x.toFixed(1)}" cy="${position.y.toFixed(1)}" r="${radius.toFixed(1)}" fill="${fill}" />
          <text x="${position.x.toFixed(1)}" y="${(position.y + radius + 16).toFixed(1)}" font-size="${labelSize.toFixed(1)}">${escapeSvg(node.name)}</text>
        </g>
        <title>${escapeSvg(`${node.name} · ${node.count} 个视频 · ${degree.get(node.name)} 条关联`)}</title>
      </g>
    `;
  }).join("");

  container.innerHTML = `
    <div class="tag-graph-wrap">
      <svg class="tag-graph-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="标签关系蛛网图">
        <defs>
          <radialGradient id="tagGraphGlow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stop-color="#fb7299" stop-opacity=".18"></stop>
            <stop offset="100%" stop-color="#fb7299" stop-opacity="0"></stop>
          </radialGradient>
        </defs>
        <circle cx="${centerX}" cy="${centerY}" r="132" fill="url(#tagGraphGlow)" />
        <g class="tag-graph-viewport" transform="translate(${app.tagGraph.panX} ${app.tagGraph.panY}) scale(${app.tagGraph.zoom})">
          <g class="tag-edges">${edgeHtml}</g>
          <g class="tag-nodes">${nodeHtml}</g>
        </g>
      </svg>
      <div class="tag-graph-legend"><span class="legend-dot"></span>节点越大，标签出现越频繁 · 线条越粗，共现越多</div>
    </div>
  `;
  container.dataset.graphSignature = graphSignature;
  const svg = container.querySelector(".tag-graph-svg");
  const viewport = container.querySelector(".tag-graph-viewport");
  let drag = null;
  svg.addEventListener("pointerdown", (event) => {
    if (event.target.closest(".tag-node")) return;
    drag = { x: event.clientX, y: event.clientY, panX: app.tagGraph.panX, panY: app.tagGraph.panY };
    svg.classList.add("dragging");
    svg.setPointerCapture?.(event.pointerId);
  });
  svg.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const rect = svg.getBoundingClientRect();
    const scaleX = 560 / Math.max(1, rect.width);
    const scaleY = 560 / Math.max(1, rect.height);
    app.tagGraph.panX = drag.panX + (event.clientX - drag.x) * scaleX;
    app.tagGraph.panY = drag.panY + (event.clientY - drag.y) * scaleY;
    clampTagGraphPan();
    applyTagGraphTransform(viewport);
  });
  const stopDrag = () => {
    drag = null;
    svg.classList.remove("dragging");
  };
  svg.addEventListener("pointerup", stopDrag);
  svg.addEventListener("pointercancel", stopDrag);
  svg.addEventListener("wheel", (event) => {
    event.preventDefault();
    const direction = event.deltaY < 0 ? 1 : -1;
    app.tagGraph.zoom = clampNumber(app.tagGraph.zoom + direction * 0.12, 0.65, 2.5);
    clampTagGraphPan();
    applyTagGraphTransform(viewport);
  }, { passive: false });

  const applyTagFilter = (name) => {
    const bvids = cloud.tagBvids?.[name] || [];
    app.tagFilter = name;
    app.tagFilterBvids = new Set(bvids);
    app.page = 1;
    renderMetrics();
    renderListIfNeeded(true);
    renderTagCloud();
  };
  const updateHoverHighlight = (name) => {
    container.querySelectorAll(".tag-node").forEach((item) => {
      const connected = isTagConnected(name, item.dataset.tag, validEdges);
      item.classList.toggle("hovered", item.dataset.tag === name);
      item.classList.toggle("connected", connected && item.dataset.tag !== name);
      item.classList.toggle("dim", !connected);
    });
    container.querySelectorAll(".tag-edge").forEach((edge) => {
      const connected = edge.dataset.source === name || edge.dataset.target === name;
      edge.classList.toggle("focus", connected);
      edge.classList.toggle("dim", !connected);
    });
  };
  container.querySelectorAll(".tag-node").forEach((node) => {
    node.onclick = () => applyTagFilter(node.dataset.tag);
    node.onkeydown = (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        applyTagFilter(node.dataset.tag);
      }
    };
    node.onmouseenter = () => {
      updateHoverHighlight(node.dataset.tag);
    };
    node.onmouseleave = () => {
      container.querySelectorAll(".tag-node, .tag-edge").forEach((item) => item.classList.remove("dim", "focus"));
      container.querySelectorAll(".tag-node").forEach((item) => item.classList.remove("hovered", "connected"));
      updateTagGraphHighlight(container, app.tagFilter);
    };
  });
  updateTagGraphHighlight(container, app.tagFilter);
}

function applyTagGraphTransform(viewport) {
  if (!viewport) return;
  viewport.setAttribute(
    "transform",
    `translate(${app.tagGraph.panX.toFixed(2)} ${app.tagGraph.panY.toFixed(2)}) scale(${app.tagGraph.zoom.toFixed(3)})`,
  );
}

function updateTagGraphHighlight(container, activeTag) {
  const edges = [...container.querySelectorAll(".tag-edge")];
  container.querySelectorAll(".tag-node").forEach((node) => {
    node.classList.toggle("active", Boolean(activeTag) && node.dataset.tag === activeTag);
    node.classList.remove("hovered", "connected");
    node.classList.toggle("dim", Boolean(activeTag) && node.dataset.tag !== activeTag && !isTagConnected(activeTag, node.dataset.tag, edges));
  });
  edges.forEach((edge) => {
    const connected = !activeTag || edge.dataset.source === activeTag || edge.dataset.target === activeTag;
    edge.classList.remove("focus");
    edge.classList.toggle("dim", !connected);
  });
}

function isTagConnected(name, other, edges) {
  return name === other || edges.some((edge) => (
    (edge.source === name && edge.target === other) || (edge.source === other && edge.target === name)
  ));
}

function buildTagGraphFallback(cloud) {
  const nodes = (cloud.tags || []).slice(0, 36).map((tag) => ({
    name: tag.name,
    count: Number(tag.count || 0),
  }));
  const names = new Set(nodes.map((node) => node.name));
  const tagBvids = cloud.tagBvids || {};
  const edges = [];
  for (let index = 0; index < nodes.length; index += 1) {
    for (let next = index + 1; next < nodes.length; next += 1) {
      const source = nodes[index].name;
      const target = nodes[next].name;
      const sourceVideos = new Set(tagBvids[source] || []);
      const count = (tagBvids[target] || []).reduce(
        (total, bvid) => total + (sourceVideos.has(bvid) ? 1 : 0),
        0,
      );
      if (count > 0 && names.has(source) && names.has(target)) {
        edges.push({ source, target, count });
      }
    }
  }
  edges.sort((a, b) => b.count - a.count);
  return { nodes, edges: edges.slice(0, 140) };
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
  menu.style.maxHeight = `${Math.min(420, maxHeight)}px`;
}

function portalFavDropdownMenu() {
  const menu = $("favDropdownMenu");
  if (menu && menu.parentElement !== document.body) {
    menu.classList.add("dropdown-portal");
    document.body.appendChild(menu);
  }
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
  if (open) portalFavDropdownMenu();
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
  const items = app.mode === "creator" ? (app.state.creatorVideos || []) : (app.state.favVideos || []);
  $("chartTitle").textContent = app.mode === "creator" ? "投稿月份分布" : "月份分布";
  if (!items.length) {
    if (chart.dataset.dataSignature !== "empty") {
      select.innerHTML = "";
      select.dataset.signature = "";
      chart.innerHTML = `<div class="empty">暂无当前数据</div>`;
      chart.dataset.dataSignature = "empty";
    }
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
  const totalsByMonth = new Map();
  const doneByMonth = new Map();
  for (const item of items) {
    const month = item.month || "";
    totalsByMonth.set(month, (totalsByMonth.get(month) || 0) + 1);
    if (history.has(item.bvid)) doneByMonth.set(month, (doneByMonth.get(month) || 0) + 1);
  }
  const data = Array.from({ length: 12 }, (_, idx) => {
    const month = `${app.selectedYear}-${String(idx + 1).padStart(2, "0")}`;
    return {
      month,
      label: String(idx + 1).padStart(2, "0"),
      total: totalsByMonth.get(month) || 0,
      done: doneByMonth.get(month) || 0,
    };
  });
  const maxTotal = Math.max(1, ...data.map((x) => x.total));
  const dataSignature = JSON.stringify({ mode: app.mode, year: app.selectedYear, data });
  if (chart.dataset.dataSignature !== dataSignature) {
    chart.dataset.dataSignature = dataSignature;
    chart.innerHTML = data.map((x) => {
      const totalH = Math.max(3, Math.round((x.total / maxTotal) * 100));
      const doneH = x.total ? Math.round((x.done / maxTotal) * 100) : 0;
      const tip = `${x.month}: ${x.done}/${x.total}`;
      return `
        <div class="month-bar" data-month="${escapeAttr(x.month)}" title="${escapeAttr(tip)}">
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
        if (app.mode === "manual") return;
        const month = bar.dataset.month;
        app.monthFilter = app.monthFilter === month ? "" : month;
        app.page = 1;
        renderMetrics();
        renderChart();
        renderListIfNeeded(true);
      };
    });
  }
  chart.querySelectorAll(".month-bar").forEach((bar) => {
    bar.classList.toggle("active", app.monthFilter === bar.dataset.month);
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
    tagFilter: app.tagFilter,
    items: pageItems.map((x) => [x.bvid, x.title, x.cover, x.month, x.duration]),
  });
  if (signature === app.listSignature) {
    $("pageInfo").textContent = `Page ${app.page} / ${totalPages}`;
    updateListVisualState(pageItems);
    return;
  }
  app.listSignature = signature;
  renderList(pageItems, totalPages);
}

function updateListVisualState(pageItems = []) {
  const history = historySet();
  const byBvid = new Map(pageItems.map((item) => [item.bvid, item]));
  $("videoList").querySelectorAll(".video-card").forEach((card) => {
    const item = byBvid.get(card.dataset.bvid);
    if (!item) return;
    const done = history.has(item.bvid);
    const selected = app.selected.has(item.bvid);
    card.classList.toggle("done", done);
    card.classList.toggle("selected", selected);
    const checkbox = card.querySelector(".check");
    if (checkbox) checkbox.checked = selected;
    const badge = card.querySelector(".badge");
    if (badge) {
      badge.classList.toggle("done", done);
      badge.textContent = done ? "已下" : "未下";
    }
  });
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
    if (app.mode !== "manual" && app.groupByMonth && item.month !== lastMonth) {
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
      showVideoContextMenu(event.clientX, event.clientY, bvid);
    });
  });
  list.querySelectorAll(".cover img").forEach((img) => {
    img.addEventListener("load", () => img.classList.add("loaded"));
    if (img.complete) img.classList.add("loaded");
  });
  updateListVisualState(pageItems);
}

function videoPageUrl(bvid) {
  return `https://www.bilibili.com/video/${encodeURIComponent(String(bvid || "").trim())}`;
}

function showVideoContextMenu(clientX, clientY, bvid) {
  const menu = $("videoContextMenu");
  if (!menu || !bvid) return;
  app.contextMenuBvid = String(bvid);
  menu.classList.remove("hidden");
  menu.style.left = "0px";
  menu.style.top = "0px";

  const padding = 8;
  const maxLeft = Math.max(padding, window.innerWidth - menu.offsetWidth - padding);
  const maxTop = Math.max(padding, window.innerHeight - menu.offsetHeight - padding);
  menu.style.left = `${Math.min(Math.max(padding, clientX), maxLeft)}px`;
  menu.style.top = `${Math.min(Math.max(padding, clientY), maxTop)}px`;
}

function hideVideoContextMenu() {
  const menu = $("videoContextMenu");
  if (menu) menu.classList.add("hidden");
  app.contextMenuBvid = "";
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
  if ($("syncBiliTagsEagle")) $("syncBiliTagsEagle").checked = cfg.syncBiliTags !== false;
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
  const signature = `${app.diagnosticsLoading ? "loading" : "ready"}:${JSON.stringify(app.diagnostics)}`;
  if (list.dataset.signature === signature) return;
  list.dataset.signature = signature;
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
  const folderSignature = JSON.stringify((app.eagleFolders || []).map((item) => [item.id, item.path, item.name]));
  if (select.dataset.folderSignature !== folderSignature) {
    const options = [`<option value="">导入到 Eagle 默认位置</option>`]
      .concat((app.eagleFolders || []).map((item) => {
        const id = escapeAttr(item.id || "");
        const path = escapeHtml(item.path || item.name || item.id || "");
        return `<option value="${id}">${path}</option>`;
      }));
    select.innerHTML = options.join("");
    select.dataset.folderSignature = folderSignature;
  }
  if (select.value !== current) select.value = current;
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
  const last = logs[logs.length - 1] || {};
  const signature = `${logs.length}:${last.time || ""}:${last.text || ""}`;
  if ($("logs").dataset.signature === signature) return;
  $("logs").dataset.signature = signature;
  $("logs").innerHTML = logs.map((item) => `<div><span class="muted">[${escapeHtml(item.time)}]</span> ${escapeHtml(item.text)}</div>`).join("");
  $("logs").scrollTop = $("logs").scrollHeight;
}

function toggleSelect(bvid) {
  if (app.selected.has(bvid)) app.selected.delete(bvid);
  else app.selected.add(bvid);
  renderMetrics();
  updateListVisualState();
}

function selectedArray() {
  return [...app.selected];
}

async function refresh() {
  if (app.refreshing) return;
  app.refreshing = true;
  try {
    app.state = await api("/api/state");
    renderState();
  } catch (error) {
    console.error(error);
  } finally {
    app.refreshing = false;
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
        <h3>旧 Eagle 视频同步标签</h3>
        <ol>
          <li>选择正确的 Eagle .library 库目录。</li>
          <li>如果只处理部分视频，先在中间列表勾选它们；不勾选则处理下载记录中的全部 BV 号。</li>
          <li>点击“只给历史 Eagle 视频同步标签”。</li>
        </ol>
        <p>这个功能不需要本地视频，不会重新下载、重新导入或重新生成封面。程序会优先按 Eagle 项目 ID 和 BV 号匹配，最后才使用唯一标题匹配；无法确认的项目会跳过。</p>
        <p>执行时建议关闭 Eagle，避免 Eagle 同时写入库文件。标签会统一放进独立的“BiliDownloader 标签”标签组，原有 Eagle 标签不会被删除。</p>
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
    const root = $("favDropdown");
    const menu = $("favDropdownMenu");
    if (!root.contains(event.target) && !menu.contains(event.target)) closeFavDropdown();
  });
  window.addEventListener("resize", positionFavDropdownMenu);
  document.querySelector(".rail")?.addEventListener("scroll", positionFavDropdownMenu, { passive: true });
  $("modeFav").onclick = () => setMode("fav");
  $("modeCreator").onclick = () => setMode("creator");
  $("modeManual").onclick = () => setMode("manual");
  $("creatorSearchBtn").onclick = async () => {
    const query = $("creatorQuery").value.trim();
    if (!query) return toast("请输入账号名称、UID 或主页链接");
    if (app.creatorSearchController) app.creatorSearchController.abort();
    const controller = new AbortController();
    app.creatorSearchController = controller;
    const requestId = ++app.creatorSearchRequestId;
    app.creatorSearchRunning = true;
    app.creatorCandidates = [];
    app.selectedCreatorMid = "";
    renderCreatorSource();
    try {
      const result = await api("/api/creator/search", {
        method: "POST",
        body: { query },
        signal: controller.signal,
      });
      if (requestId !== app.creatorSearchRequestId) return;
      app.creatorCandidates = result.results || [];
      if (app.creatorCandidates.length === 1) {
        app.selectedCreatorMid = String(app.creatorCandidates[0].mid);
      }
      if (!app.creatorCandidates.length) toast("没有找到匹配账号");
      renderCreatorSource();
      renderGuide();
    } catch (error) {
      if (error.name === "AbortError") return;
      if (requestId !== app.creatorSearchRequestId) return;
      toast(error.message);
      renderCreatorSource();
    } finally {
      if (requestId === app.creatorSearchRequestId) {
        app.creatorSearchRunning = false;
        app.creatorSearchController = null;
        renderCreatorSource();
      }
    }
  };
  $("creatorResults").onchange = (event) => {
    app.selectedCreatorMid = event.target.value;
    renderCreatorSource();
    renderGuide();
  };
  $("creatorSyncBtn").onclick = async () => {
    const candidate = app.creatorCandidates.find(
      (item) => String(item.mid) === String(app.selectedCreatorMid),
    );
    if (!candidate) return toast("请先选择一个账号");
    try {
      await api("/api/creator/sync", {
        method: "POST",
        body: {
          mid: candidate.mid,
          name: candidate.name,
        },
      });
      toast("已开始低频获取账号投稿");
      renderCreatorSource();
    } catch (error) {
      toast(error.message);
    }
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
      toast(`导入完成：新增 ${result.added} 条，详细记录 ${result.records || 0} 条，总计 ${result.total} 条`);
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
      toast(`已导出完整记录包：${result.count} 条历史，${result.records || 0} 条详细记录`);
    } catch (error) {
      toast(error.message);
    }
  };
  $("tagRange").onchange = () => {
    clearTagFilter();
    renderTagCloud();
    renderMetrics();
    renderListIfNeeded(true);
  };
  $("tagMonth").onchange = () => {
    clearTagFilter();
    renderTagCloud();
    renderMetrics();
    renderListIfNeeded(true);
  };
  $("tagDownloadedOnly").onchange = () => {
    clearTagFilter();
    renderTagCloud();
    renderMetrics();
    renderListIfNeeded(true);
  };
  $("generateTagCloudBtn").onclick = async () => {
    try {
      const result = await api("/api/tags/cloud", {
        method: "POST",
        body: {
          source: app.mode,
          range: $("tagRange").value,
          month: $("tagMonth").value,
          downloadedOnly: $("tagDownloadedOnly").checked,
        },
      });
      toast(result.started ? "已开始低频读取视频标签" : "已使用本地标签缓存生成关系图");
      await refresh();
    } catch (error) {
      toast(error.message);
    }
  };
  $("cancelTagCloudBtn").onclick = async () => {
    try {
      await api("/api/tags/cancel", { method: "POST", body: {} });
      toast("正在停止词云生成");
      await refresh();
    } catch (error) {
      toast(error.message);
    }
  };
  $("clearTagFilterBtn").onclick = () => {
    clearTagFilter();
    app.page = 1;
    renderMetrics();
    renderListIfNeeded(true);
    renderTagCloud();
  };
  $("resetTagGraphSizeBtn").onclick = () => {
    const canvas = $("tagCloudWords");
    if (!canvas) return;
    canvas.style.width = "";
    canvas.style.height = "";
    localStorage.removeItem("bili-tag-graph-width");
    localStorage.removeItem("bili-tag-graph-height");
    toast("关系图已恢复默认尺寸");
  };
  $("openHistoryLocationBtn").onclick = async () => {
    try {
      const result = await api("/api/history/open-location", { method: "POST", body: {} });
      toast(`已打开记录位置：${result.path || result.dir || ""}`);
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
          syncBiliTags: $("syncBiliTagsEagle").checked,
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
          syncBiliTags: $("syncBiliTagsEagle").checked,
        },
      });
      toast(`Eagle \u5bfc\u5165\u5df2\u542f\u52a8\uff1a${result.total} \u4e2a\u89c6\u9891`);
      await refresh();
    } catch (error) {
      toast(error.message);
    }
  };
  $("eagleTagSyncBtn").onclick = async () => {
    try {
      if (!$("eagleLibrary").value.trim()) {
        toast("请先选择 Eagle 的 .library 库目录");
        scrollIntoPanel("chooseEagleBtn");
        return;
      }
      const result = await api("/api/eagle/tag-sync", {
        method: "POST",
        body: {
          bvids: selectedArray(),
          libraryDir: $("eagleLibrary").value.trim(),
        },
      });
      toast(`历史视频标签同步已启动：${result.total} 条记录，预计匹配 ${result.matched} 项`);
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
      syncBiliTags: $("syncBiliTagsEagle").checked,
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
      syncBiliTags: $("syncBiliTagsEagle").checked,
    },
  }).then(refresh).catch((error) => toast(error.message));
  $("syncBiliTagsEagle").onchange = () => api("/api/eagle/config", {
    method: "POST",
    body: {
      libraryDir: $("eagleLibrary").value.trim(),
      folderId: $("eagleFolder").value,
      speedMode: $("eagleSpeedMode").value,
      deleteAfterImport: $("deleteAfterEagle").checked,
      useDanmaku: $("useDanmakuEagle").checked,
      syncBiliTags: $("syncBiliTagsEagle").checked,
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
      syncBiliTags: $("syncBiliTagsEagle").checked,
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
      syncBiliTags: $("syncBiliTagsEagle").checked,
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
  $("openVideoPageBtn").onclick = () => {
    const bvid = app.contextMenuBvid;
    hideVideoContextMenu();
    if (!bvid) return;
    window.open(videoPageUrl(bvid), "_blank", "noopener,noreferrer");
  };
  $("copyVideoBvidBtn").onclick = async () => {
    const bvid = app.contextMenuBvid;
    hideVideoContextMenu();
    if (!bvid) return;
    try {
      await navigator.clipboard?.writeText(bvid);
      toast(`已复制 ${bvid}`);
    } catch (error) {
      toast(`BV 号：${bvid}`);
    }
  };
  document.addEventListener("click", (event) => {
    if (!event.target.closest("#videoContextMenu")) hideVideoContextMenu();
  });
  document.addEventListener("contextmenu", (event) => {
    if (!event.target.closest(".video-card")) hideVideoContextMenu();
  });
  document.addEventListener("scroll", hideVideoContextMenu, true);
  window.addEventListener("resize", hideVideoContextMenu);
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
      hideVideoContextMenu();
      app.selected.clear();
      renderMetrics();
      renderListIfNeeded(true);
    }
  });
}

initResizableLayout();
initTagGraphCanvas();
bindEvents();
refresh();
setInterval(refresh, 1400);

