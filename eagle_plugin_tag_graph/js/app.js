(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const CACHE_KEY = "bili-tag-graph-eagle-cache-v1";
  const GRAPH_SIZE = 720;
  const MAX_NODES = 42;
  const MAX_EDGES = 180;
  const state = {
    library: null,
    folders: [],
    selectedFolders: [],
    groups: [],
    allItems: [],
    sourceItems: [],
    tags: [],
    edges: [],
    activeTag: "",
    search: "",
    scope: "all",
    group: "all",
    zoom: 1,
    panX: 0,
    panY: 0,
    zoomTarget: 1,
    panTargetX: 0,
    panTargetY: 0,
    zoomFrame: 0,
    loading: false,
    cacheUsed: false,
  };

  const safeArray = (value) => Array.isArray(value) ? value : [];
  const text = (value) => String(value == null ? "" : value).trim();
  const itemModifiedAt = (item) => Number(item.modifiedAt || item.lastModified || 0);

  function setMessage(value, kind = "") {
    const node = $("message");
    node.textContent = value;
    node.className = `message ${kind}`.trim();
  }

  function setBusy(value) {
    state.loading = value;
    $("refreshButton").disabled = value;
    $("scopeSelect").disabled = value;
    $("groupSelect").disabled = value;
    $("cacheBadge").textContent = value ? "读取中" : (state.cacheUsed ? "使用缓存" : "已连接");
  }

  function normalizeItem(item) {
    return {
      id: text(item.id),
      name: text(item.name) || "未命名项目",
      tags: cleanTags(item.tags),
      folders: safeArray(item.folders).map(text).filter(Boolean),
      ext: text(item.ext).toLowerCase(),
      modifiedAt: itemModifiedAt(item),
      url: text(item.url),
    };
  }

  function cleanTags(values) {
    const seen = new Set();
    return safeArray(values).map(text).filter((tag) => {
      const key = tag.toLocaleLowerCase();
      if (!tag || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function readCache() {
    try {
      const value = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
      return value && typeof value === "object" ? value : null;
    } catch {
      return null;
    }
  }

  function writeCache() {
    const payload = {
      libraryPath: text(state.library?.path),
      modificationTime: Number(state.library?.modificationTime || 0),
      savedAt: Date.now(),
      items: state.allItems,
      folders: state.folders,
      groups: state.groups.map((group) => ({ name: text(group.name), tags: cleanTags(group.tags) })),
    };
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
    } catch {
      setMessage("缓存写入失败，但当前关系图仍可使用。", "warning");
    }
  }

  async function readLibraryInfo() {
    if (window.eagle?.library?.info) {
      const info = await eagle.library.info();
      return info?.library || info || {};
    }
    return { name: "演示资源库", path: "demo://library", modificationTime: 1 };
  }

  async function readFolders() {
    if (window.eagle?.folder?.getAll) return safeArray(await eagle.folder.getAll());
    return [];
  }

  async function readSelectedFolders() {
    if (window.eagle?.folder?.getSelected) return safeArray(await eagle.folder.getSelected());
    return [];
  }

  async function readGroups() {
    if (window.eagle?.tagGroup?.get) return safeArray(await eagle.tagGroup.get());
    return [];
  }

  async function readItems() {
    if (window.eagle?.item?.get) {
      const items = await eagle.item.get({
        fields: ["id", "name", "tags", "folders", "ext", "modifiedAt", "url"],
      });
      return safeArray(items).map(normalizeItem).filter((item) => item.id);
    }
    return demoItems();
  }

  function demoItems() {
    return [
      { id: "demo-1", name: "原神角色 PV", tags: ["原神", "角色PV", "游戏"], folders: ["folder-1"], ext: "mp4" },
      { id: "demo-2", name: "动作设计参考", tags: ["动作", "游戏", "参考"], folders: ["folder-1"], ext: "mp4" },
      { id: "demo-3", name: "音乐现场", tags: ["音乐", "现场", "演出"], folders: ["folder-2"], ext: "mp4" },
      { id: "demo-4", name: "角色立绘", tags: ["原神", "角色", "参考"], folders: ["folder-2"], ext: "jpg" },
      { id: "demo-5", name: "PV 分镜", tags: ["角色PV", "分镜", "参考"], folders: ["folder-1"], ext: "mp4" },
      { id: "demo-6", name: "剪辑节奏", tags: ["剪辑", "音乐", "参考"], folders: ["folder-2"], ext: "mp4" },
    ].map(normalizeItem);
  }

  function canUseCache(cache) {
    return Boolean(
      cache &&
      cache.libraryPath === text(state.library?.path) &&
      Number(cache.modificationTime || 0) === Number(state.library?.modificationTime || 0) &&
      Array.isArray(cache.items),
    );
  }

  async function loadData(force = false) {
    if (state.loading) return;
    setBusy(true);
    try {
      state.library = await readLibraryInfo();
      $("libraryLine").textContent = `${text(state.library.name) || "当前资源库"} · ${text(state.library.path) || "路径不可用"}`;
      const cache = force ? null : readCache();
      if (canUseCache(cache)) {
        state.allItems = cache.items.map(normalizeItem);
        state.folders = safeArray(cache.folders);
        state.groups = safeArray(cache.groups);
        state.selectedFolders = await readSelectedFolders();
        state.cacheUsed = true;
        setMessage("已使用本地索引缓存。库内容有变化时，请点击“刷新库缓存”。", "success");
      } else {
        const [items, folders, groups, selectedFolders] = await Promise.all([
          readItems(),
          readFolders(),
          readGroups(),
          readSelectedFolders(),
        ]);
        state.allItems = items;
        state.folders = folders;
        state.groups = groups;
        state.selectedFolders = selectedFolders;
        state.cacheUsed = false;
        writeCache();
        setMessage("索引缓存已刷新。插件只读取数据，不会修改 Eagle 内容。", "success");
      }
      renderGroupOptions();
      updateView();
    } catch (error) {
      state.allItems = [];
      state.folders = [];
      state.groups = [];
      setMessage(`读取 Eagle 数据失败：${error?.message || error}`, "error");
      renderEmpty("无法读取当前资源库。请确认 Eagle 版本支持 Plugin API。");
    } finally {
      setBusy(false);
    }
  }

  function renderGroupOptions() {
    const select = $("groupSelect");
    const current = state.group;
    const options = ['<option value="all">全部实际使用的标签</option>']
      .concat(state.groups
        .filter((group) => text(group.name) && safeArray(group.tags).length)
        .map((group) => `<option value="${escapeAttr(text(group.name))}">${escapeHtml(text(group.name))}</option>`));
    select.innerHTML = options.join("");
    state.group = [...select.options].some((option) => option.value === current) ? current : "all";
    select.value = state.group;
  }

  function selectedFolderIds() {
    return new Set(state.selectedFolders.map((folder) => text(folder.id)).filter(Boolean));
  }

  async function readSelectedItems() {
    if (window.eagle?.item?.getSelected) return safeArray(await eagle.item.getSelected()).map(normalizeItem);
    return state.allItems.filter((item) => item.id.startsWith("demo-")).slice(0, 3);
  }

  function updateView() {
    if (state.scope === "selected") {
      readSelectedItems().then((items) => {
        state.sourceItems = items;
        buildGraph();
        renderAll();
      }).catch((error) => setMessage(`读取选中项目失败：${error?.message || error}`, "error"));
      return;
    }
    if (state.scope === "folder") {
      const ids = selectedFolderIds();
      state.sourceItems = ids.size ? state.allItems.filter((item) => item.folders.some((id) => ids.has(id))) : [];
    } else {
      state.sourceItems = [...state.allItems];
    }
    buildGraph();
    renderAll();
  }

  function filteredTagNames() {
    const group = state.groups.find((candidate) => text(candidate.name) === state.group);
    const groupTags = state.group === "all" ? null : new Set(cleanTags(group?.tags));
    const search = state.search.toLocaleLowerCase();
    return state.tags
      .filter((tag) => !groupTags || groupTags.has(tag.name))
      .filter((tag) => !search || tag.name.toLocaleLowerCase().includes(search))
      .map((tag) => tag.name);
  }

  function buildGraph() {
    const counts = new Map();
    const tagItems = new Map();
    state.sourceItems.forEach((item) => item.tags.forEach((tag) => {
      counts.set(tag, (counts.get(tag) || 0) + 1);
      if (!tagItems.has(tag)) tagItems.set(tag, new Set());
      tagItems.get(tag).add(item.id);
    }));
    state.tags = [...counts.entries()]
      .map(([name, count]) => ({ name, count, itemIds: [...tagItems.get(name)] }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh-CN"))
      .slice(0, 180);
    const shown = new Set(filteredTagNames().slice(0, MAX_NODES));
    const edgeCounts = new Map();
    state.sourceItems.forEach((item) => {
      const tags = item.tags.filter((tag) => shown.has(tag));
      for (let i = 0; i < tags.length; i += 1) {
        for (let j = i + 1; j < tags.length; j += 1) {
          const pair = [tags[i], tags[j]].sort();
          const key = `${pair[0]}\u0000${pair[1]}`;
          edgeCounts.set(key, (edgeCounts.get(key) || 0) + 1);
        }
      }
    });
    state.edges = [...edgeCounts.entries()]
      .map(([key, count]) => {
        const [source, target] = key.split("\u0000");
        return { source, target, count };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, MAX_EDGES);
    if (state.activeTag && !state.tags.some((tag) => tag.name === state.activeTag)) state.activeTag = "";
  }

  function renderAll() {
    renderStats();
    renderTagList();
    renderResults();
    renderGraph();
  }

  function renderStats() {
    const tagged = state.sourceItems.filter((item) => item.tags.length).length;
    $("statsLine").textContent = `${state.sourceItems.length} 个项目 · ${tagged} 个有标签 · ${state.tags.length} 个实际标签`;
    $("tagCount").textContent = String(state.tags.length);
    $("footerStatus").textContent = state.scope === "selected"
      ? "当前图只分析 Eagle 当前选中的项目。"
      : "标签关联按同一项目中的共现关系计算。";
  }

  function renderTagList() {
    const names = new Set(filteredTagNames());
    const tags = state.tags.filter((tag) => names.has(tag.name));
    $("tagList").innerHTML = tags.length ? tags.map((tag) => `
      <button class="tag-row ${state.activeTag === tag.name ? "active" : ""}" type="button" data-tag="${escapeAttr(tag.name)}">
        <span class="tag-name">${escapeHtml(tag.name)}</span><span class="tag-count">${tag.count}</span>
      </button>
    `).join("") : '<div class="empty">没有符合条件的实际标签。</div>';
    $("tagList").querySelectorAll("[data-tag]").forEach((button) => button.addEventListener("click", () => selectTag(button.dataset.tag)));
  }

  function renderResults() {
    const section = $("resultSection");
    if (!section) return;
    const tag = state.tags.find((candidate) => candidate.name === state.activeTag);
    if (!tag) {
      section.classList.add("hidden");
      $("resultList").innerHTML = "";
      return;
    }
    const itemIds = new Set(tag.itemIds);
    const items = state.sourceItems.filter((item) => itemIds.has(item.id));
    section.classList.remove("hidden");
    $("resultCount").textContent = String(items.length);
    $("resultList").innerHTML = items.length ? items.map((item) => `
      <button class="result-row" type="button" data-item-id="${escapeAttr(item.id)}">
        <span class="result-icon">${escapeHtml((item.ext || "file").slice(0, 3).toUpperCase())}</span>
        <span class="result-copy"><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.ext || "Eagle 项目")}</small></span>
        <span class="result-arrow">›</span>
      </button>
    `).join("") : '<div class="empty">当前范围内没有对应项目。</div>';
    $("resultList").querySelectorAll("[data-item-id]").forEach((button) => {
      button.addEventListener("click", () => openItem(button.dataset.itemId));
    });
  }

  async function openItem(itemId) {
    if (!itemId || !window.eagle?.item?.open) return;
    try {
      await eagle.item.open(itemId);
    } catch (error) {
      setMessage(`打开 Eagle 项目失败：${error?.message || error}`, "error");
    }
  }

  function renderEmpty(message) {
    $("graphHost").innerHTML = `<div class="empty graph-empty">${escapeHtml(message)}</div>`;
    $("tagList").innerHTML = '<div class="empty">暂无标签数据。</div>';
  }

  function renderGraph() {
    const names = filteredTagNames().slice(0, MAX_NODES);
    const nodes = names.map((name) => state.tags.find((tag) => tag.name === name)).filter(Boolean);
    if (!nodes.length) {
      renderEmpty(state.sourceItems.length ? "当前范围内没有实际使用中的标签。" : "当前范围没有项目。");
      return;
    }
    const positions = layoutNodes(nodes);
    const nodeMap = new Map(nodes.map((node) => [node.name, node]));
    const validEdges = state.edges.filter((edge) => nodeMap.has(edge.source) && nodeMap.has(edge.target));
    const maxCount = Math.max(1, ...nodes.map((node) => node.count));
    const maxEdge = Math.max(1, ...validEdges.map((edge) => edge.count));
    const active = state.activeTag;
    const edgeHtml = validEdges.map((edge) => {
      const source = positions.get(edge.source);
      const target = positions.get(edge.target);
      const focused = !active || edge.source === active || edge.target === active;
      return `<line class="graph-edge ${focused ? "" : "dim"}" data-source="${escapeAttr(edge.source)}" data-target="${escapeAttr(edge.target)}" x1="${source.x}" y1="${source.y}" x2="${target.x}" y2="${target.y}" stroke-width="${(1 + edge.count / maxEdge * 4).toFixed(2)}"/>`;
    }).join("");
    const nodeHtml = nodes.map((node, index) => {
      const point = positions.get(node.name);
      const ratio = node.count / maxCount;
      const radius = 13 + ratio * 20 + Math.min(6, point.degree * 0.8);
      const connected = !active || active === node.name || validEdges.some((edge) => (
        (edge.source === active && edge.target === node.name) ||
        (edge.target === active && edge.source === node.name)
      ));
      return `<g class="graph-node ${active === node.name ? "active" : ""} ${connected ? "" : "dim"}" data-tag="${escapeAttr(node.name)}" tabindex="0" role="button" aria-label="${escapeAttr(`${node.name}，${node.count} 个项目`)}">
        <g class="node-float" style="--delay:${-(index % 7) * 0.6}s;--duration:${(5 + index % 4 * 0.8).toFixed(1)}s">
          <circle cx="${point.x}" cy="${point.y}" r="${radius.toFixed(1)}" fill="${colorFor(node.name)}"/>
          <text x="${point.x}" y="${(point.y + radius + 19).toFixed(1)}">${escapeHtml(node.name)}</text>
        </g>
        <title>${escapeHtml(`${node.name} · ${node.count} 个项目`)}</title>
      </g>`;
    }).join("");
    $("graphHost").innerHTML = `
      <svg id="graphSvg" class="graph-svg" viewBox="0 0 ${GRAPH_SIZE} ${GRAPH_SIZE}" preserveAspectRatio="xMidYMid meet" aria-label="标签关系蛛网图">
        <defs><radialGradient id="graphGlow" cx="50%" cy="50%" r="55%">
          <stop offset="0%" stop-color="#fb7299" stop-opacity=".2"/><stop offset="100%" stop-color="#fb7299" stop-opacity="0"/>
        </radialGradient></defs>
        <circle cx="${GRAPH_SIZE / 2}" cy="${GRAPH_SIZE / 2}" r="210" fill="url(#graphGlow)"/>
        <g id="graphViewport" transform="translate(${state.panX} ${state.panY}) scale(${state.zoom})">
          <g class="graph-edges">${edgeHtml}</g><g class="graph-nodes">${nodeHtml}</g>
        </g>
      </svg>`;
    bindGraphEvents();
  }

  function layoutNodes(nodes) {
    const center = GRAPH_SIZE / 2;
    const positions = new Map();
    const sorted = [...nodes].sort((a, b) => b.count - a.count);
    sorted.forEach((node, index) => {
      if (index === 0) {
        positions.set(node.name, { x: center, y: center, degree: 0 });
        return;
      }
      const ring = index <= 8 ? 1 : index <= 22 ? 2 : 3;
      const ringStart = ring === 1 ? 1 : ring === 2 ? 9 : 23;
      const ringCount = ring === 1 ? 8 : ring === 2 ? 14 : Math.max(1, sorted.length - 22);
      const ringIndex = index - ringStart;
      const radius = ring === 1 ? 130 : ring === 2 ? 245 : 315;
      const angle = ringIndex / ringCount * Math.PI * 2 - Math.PI / 2 + (ring % 2 ? 0 : Math.PI / ringCount);
      positions.set(node.name, { x: Math.round(center + Math.cos(angle) * radius), y: Math.round(center + Math.sin(angle) * radius), degree: 0 });
    });
    state.edges.forEach((edge) => {
      if (positions.has(edge.source)) positions.get(edge.source).degree += 1;
      if (positions.has(edge.target)) positions.get(edge.target).degree += 1;
    });
    return positions;
  }

  function bindGraphEvents() {
    const svg = $("graphSvg");
    const viewport = $("graphViewport");
    if (!svg) return;
    let drag = null;
    svg.addEventListener("pointerdown", (event) => {
      if (event.target.closest(".graph-node")) return;
      drag = { x: event.clientX, y: event.clientY, panX: state.panX, panY: state.panY };
      svg.classList.add("dragging");
      svg.setPointerCapture?.(event.pointerId);
    });
    svg.addEventListener("pointermove", (event) => {
      if (!drag) return;
      const rect = svg.getBoundingClientRect();
      state.panX = drag.panX + (event.clientX - drag.x) * GRAPH_SIZE / Math.max(1, rect.width);
      state.panY = drag.panY + (event.clientY - drag.y) * GRAPH_SIZE / Math.max(1, rect.height);
      clampPan();
      applyTransform(viewport);
    });
    const stop = () => { drag = null; svg.classList.remove("dragging"); };
    svg.addEventListener("pointerup", stop);
    svg.addEventListener("pointercancel", stop);
    svg.addEventListener("wheel", (event) => {
      event.preventDefault();
      const rect = svg.getBoundingClientRect();
      const pointerX = (event.clientX - rect.left) / Math.max(1, rect.width) * GRAPH_SIZE;
      const pointerY = (event.clientY - rect.top) / Math.max(1, rect.height) * GRAPH_SIZE;
      const currentZoom = state.zoom;
      const currentPanX = state.panX;
      const currentPanY = state.panY;
      const worldX = (pointerX - currentPanX) / currentZoom;
      const worldY = (pointerY - currentPanY) / currentZoom;
      const baseTarget = Number.isFinite(state.zoomTarget) ? state.zoomTarget : currentZoom;
      const targetZoom = clamp(baseTarget * (event.deltaY < 0 ? 1.12 : 0.89), 0.62, 2.4);
      state.zoomTarget = targetZoom;
      state.panTargetX = pointerX - worldX * targetZoom;
      state.panTargetY = pointerY - worldY * targetZoom;
      clampTargetPan();
      startZoomMotion();
    }, { passive: false });
    svg.querySelectorAll(".graph-node").forEach((node) => {
      node.addEventListener("click", () => selectTag(node.dataset.tag));
      node.addEventListener("mouseenter", () => highlightHover(svg, node.dataset.tag));
      node.addEventListener("mouseleave", () => updateHighlight(svg, state.activeTag));
      node.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          selectTag(node.dataset.tag);
        }
      });
    });
  }

  function highlightHover(svg, name) {
    svg.querySelectorAll(".graph-node").forEach((node) => {
      const connected = node.dataset.tag === name || state.edges.some((edge) => (
        (edge.source === name && edge.target === node.dataset.tag) ||
        (edge.target === name && edge.source === node.dataset.tag)
      ));
      node.classList.toggle("hovered", node.dataset.tag === name);
      node.classList.toggle("connected", connected && node.dataset.tag !== name);
      node.classList.toggle("dim", !connected);
    });
    svg.querySelectorAll(".graph-edge").forEach((edge) => {
      const focused = edge.dataset.source === name || edge.dataset.target === name;
      edge.classList.toggle("focus", focused);
      edge.classList.toggle("dim", !focused);
    });
  }

  function updateHighlight(svg, active) {
    if (!svg) return;
    svg.querySelectorAll(".graph-node").forEach((node) => {
      const connected = !active || node.dataset.tag === active || state.edges.some((edge) => (
        (edge.source === active && edge.target === node.dataset.tag) ||
        (edge.target === active && edge.source === node.dataset.tag)
      ));
      node.classList.remove("hovered", "connected");
      node.classList.toggle("dim", !connected);
      node.classList.toggle("active", node.dataset.tag === active);
    });
    svg.querySelectorAll(".graph-edge").forEach((edge) => {
      const focused = !active || edge.dataset.source === active || edge.dataset.target === active;
      edge.classList.remove("focus");
      edge.classList.toggle("dim", !focused);
    });
  }

  function selectTag(name) {
    state.activeTag = name === state.activeTag ? "" : name;
    const tag = state.tags.find((candidate) => candidate.name === state.activeTag);
    $("selectionTitle").textContent = state.activeTag || "未选择标签";
    $("selectionDetail").textContent = tag ? `${tag.count} 个项目 · 已切换到对应视频` : "点击节点或列表标签，可在 Eagle 中查看对应素材。";
    renderTagList();
    renderResults();
    renderGraph();
    if (!tag || !window.eagle?.item?.select) return;
    eagle.item.select(tag.itemIds).then(() => {
      $("selectionDetail").textContent = `${tag.count} 个项目 · Eagle 已选中`;
    }).catch((error) => {
      $("selectionDetail").textContent = `选中失败：${error?.message || error}`;
    });
  }

  function clampPan() {
    if (state.zoom <= 1) {
      const offset = (GRAPH_SIZE - GRAPH_SIZE * state.zoom) / 2;
      state.panX = offset;
      state.panY = offset;
      return;
    }
    const min = GRAPH_SIZE - GRAPH_SIZE * state.zoom;
    state.panX = clamp(state.panX, min, 0);
    state.panY = clamp(state.panY, min, 0);
  }

  function clampTargetPan() {
    if (state.zoomTarget <= 1) {
      const offset = (GRAPH_SIZE - GRAPH_SIZE * state.zoomTarget) / 2;
      state.panTargetX = offset;
      state.panTargetY = offset;
      return;
    }
    const min = GRAPH_SIZE - GRAPH_SIZE * state.zoomTarget;
    state.panTargetX = clamp(state.panTargetX, min, 0);
    state.panTargetY = clamp(state.panTargetY, min, 0);
  }

  function startZoomMotion() {
    if (state.zoomFrame) return;
    let lastTime = performance.now();
    const tick = (now) => {
      const elapsed = Math.min(48, Math.max(1, now - lastTime));
      lastTime = now;
      const amount = 1 - Math.pow(0.0008, elapsed / 1000);
      state.zoom += (state.zoomTarget - state.zoom) * amount;
      state.panX += (state.panTargetX - state.panX) * amount;
      state.panY += (state.panTargetY - state.panY) * amount;
      clampPan();
      const viewport = $("graphViewport");
      applyTransform(viewport);
      const settled = Math.abs(state.zoomTarget - state.zoom) < 0.001
        && Math.abs(state.panTargetX - state.panX) < 0.35
        && Math.abs(state.panTargetY - state.panY) < 0.35;
      if (settled) {
        state.zoom = state.zoomTarget;
        state.panX = state.panTargetX;
        state.panY = state.panTargetY;
        clampPan();
        applyTransform(viewport);
        state.zoomFrame = 0;
        return;
      }
      state.zoomFrame = requestAnimationFrame(tick);
    };
    state.zoomFrame = requestAnimationFrame(tick);
  }

  function applyTransform(viewport) {
    if (viewport) viewport.setAttribute("transform", `translate(${state.panX.toFixed(2)} ${state.panY.toFixed(2)}) scale(${state.zoom.toFixed(3)})`);
  }

  function resetView() {
    state.zoom = 1;
    state.panX = 0;
    state.panY = 0;
    state.zoomTarget = 1;
    state.panTargetX = 0;
    state.panTargetY = 0;
    clampPan();
    if (state.zoomFrame) {
      cancelAnimationFrame(state.zoomFrame);
      state.zoomFrame = 0;
    }
    renderGraph();
  }

  function colorFor(name) {
    let hash = 0;
    for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) % 360;
    return `hsl(${(hash + 175) % 360} 78% 68%)`;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, Number(value) || 0));
  }

  function escapeHtml(value) {
    return text(value).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[char]));
  }

  const escapeAttr = escapeHtml;

  function bindControls() {
    $("refreshButton").addEventListener("click", () => loadData(true));
    $("scopeSelect").addEventListener("change", (event) => {
      state.scope = event.target.value;
      updateView();
    });
    $("groupSelect").addEventListener("change", (event) => {
      state.group = event.target.value;
      buildGraph();
      renderAll();
    });
    $("tagSearch").addEventListener("input", (event) => {
      state.search = event.target.value.trim();
      buildGraph();
      renderAll();
    });
    $("resetViewButton").addEventListener("click", resetView);
    $("clearSelectionButton").addEventListener("click", () => selectTag(""));
    window.addEventListener("eagle-library-changed", () => loadData(true));
  }

  async function start() {
    await window.pluginReady;
    bindControls();
    await loadData(false);
  }

  start();
})();
