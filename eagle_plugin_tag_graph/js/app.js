(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const CACHE_KEY = "bili-tag-graph-eagle-cache-v1";
  const TAG_MERGE_CONFIRM_KEY = "bili-tag-graph-tag-merge-confirm-v1";
  const SMART_FOLDER_ID_KEY = "bili-tag-graph-smart-folder-id-v1";
  const SMART_FOLDER_NAME = "标签分析 · 当前筛选";
  const SMART_FOLDER_MARKER = "BILITAGGRAPH_SMART_FILTER_V1";
  const GRAPH_SIZE = 720;
  const INITIAL_NODE_LIMIT = 24;
  const NODE_INCREMENT = 12;
  const MAX_NODE_LIMIT = 52;
  const BUILD_LABEL = "v0.3.3 · 2026.09.02";
  const state = {
    library: null,
    folders: [],
    selectedFolders: [],
    groups: [],
    allItems: [],
    sourceItems: [],
    tags: [],
    edges: [],
    edgeIndex: new Map(),
    visibleAdjacency: new Map(),
    visibleEdgeIndex: new Map(),
    visibleEdges: [],
    graphPositions: new Map(),
    graphMaxEdge: 1,
    primaryEdgeKeys: new Set(),
    activeTag: "",
    search: "",
    scope: "all",
    group: "all",
    visibleLimit: INITIAL_NODE_LIMIT,
    visibleOffset: 0,
    zoom: 1,
    panX: 0,
    panY: 0,
    zoomTarget: 1,
    panTargetX: 0,
    panTargetY: 0,
    zoomFrame: 0,
    floatFrame: 0,
    floatStartedAt: 0,
    nodePositions: new Map(),
    manualNodePositions: new Set(),
    loading: false,
    cacheUsed: false,
    tagManagerBusy: false,
    managedTags: [],
    suppressLibraryRefreshUntil: 0,
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

  function uniqueExactTags(values) {
    const seen = new Set();
    return safeArray(values).map(text).filter((tag) => {
      if (!tag || seen.has(tag)) return false;
      seen.add(tag);
      return true;
    });
  }

  function normalizedTagKey(value) {
    return text(value).normalize("NFKC").toLocaleLowerCase();
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

  async function readManagedTags() {
    const counts = new Map();
    state.allItems.forEach((item) => item.tags.forEach((tag) => {
      counts.set(tag, (counts.get(tag) || 0) + 1);
    }));
    // Use tags actually present on items instead of eagle.tag.get(). Eagle may
    // briefly return stale tag records after a merge, including zero-count tags.
    state.managedTags = [...counts.entries()].map(([name, count]) => ({
      name,
      count,
    })).sort((a, b) => (
      b.count - a.count || a.name.localeCompare(b.name, "zh-CN")
    ));
    return state.managedTags;
  }

  function tagMergeSupported() {
    const build = Number(window.eagle?.app?.build);
    return Boolean(
      typeof window.eagle?.tag?.merge === "function"
      && (!Number.isFinite(build) || build >= 18)
    );
  }

  function setTagManagerBusy(value) {
    state.tagManagerBusy = value;
    ["tagMergeSource", "tagMergeTarget", "tagMergeSubmitButton", "tagManagerCloseButton"]
      .forEach((id) => {
        const node = $(id);
        if (node) node.disabled = value;
      });
    const button = $("tagManagerButton");
    if (button) button.disabled = value;
    if (value) $("tagMergeStatus").textContent = "正在合并并刷新资源库缓存...";
  }

  function getDuplicateTagGroups() {
    const groups = new Map();
    state.managedTags.forEach((tag) => {
      const key = normalizedTagKey(tag.name);
      if (!key) return;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(tag);
    });
    return [...groups.values()]
      .filter((tags) => tags.length > 1)
      .map((tags) => tags.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh-CN")))
      .sort((a, b) => (
        b.reduce((total, tag) => total + tag.count, 0) - a.reduce((total, tag) => total + tag.count, 0)
      ));
  }

  function renderTagManager() {
    const options = $("tagManagerOptions");
    options.innerHTML = state.managedTags.map((tag) => (
      `<option value="${escapeAttr(tag.name)}">${escapeHtml(`${tag.name} · ${tag.count} 个项目`)}</option>`
    )).join("");
    $("tagManagerCount").textContent = String(state.managedTags.length);
    const duplicateGroups = getDuplicateTagGroups();
    $("tagMergeSuggestions").innerHTML = duplicateGroups.length ? duplicateGroups.map((tags) => {
      const target = tags[0];
      return `
        <div class="tag-merge-suggestion">
          <div class="tag-merge-suggestion-tags">${tags.map((tag) => `
            <button type="button" class="tag-merge-chip"
              data-merge-source="${escapeAttr(tag.name)}" data-merge-target="${escapeAttr(target.name)}">
              <span>${escapeHtml(tag.name)}</span><b>${tag.count}</b>
            </button>`).join("")}</div>
          <span class="tag-merge-target-note">点击标签加入待合并列表；目标请手动填写</span>
        </div>`;
    }).join("") : '<div class="empty tag-manager-empty">没有发现仅大小写或全半角不同的重复标签。仍可在上方手动合并任意两个标签。</div>';
    $("tagMergeSuggestions").querySelectorAll("[data-merge-source]").forEach((button) => {
      button.addEventListener("click", () => {
        const source = button.dataset.mergeSource;
        const target = button.dataset.mergeTarget;
        const current = parseMergeSources($("tagMergeSource").value);
        const next = current.includes(source)
          ? current.filter((name) => name !== source)
          : [...current, source];
        $("tagMergeSource").value = next.join(", ");
        const selectedTarget = text($("tagMergeTarget").value);
        $("tagMergeStatus").textContent = next.length
          ? (selectedTarget
            ? `已选择 ${next.length} 个源标签，目标为 “${selectedTarget}”。`
            : `已选择 ${next.length} 个源标签，请在“保留为”中手动填写目标。`)
          : "尚未选择源标签。";
        syncMergeChipSelection();
        renderSourceSuggestions();
      });
    });
    $("tagMergeSource").oninput = () => {
      syncMergeChipSelection();
      renderSourceSuggestions();
    };
    $("tagMergeSource").onfocus = renderSourceSuggestions;
    $("tagMergeSource").onblur = () => {
      window.setTimeout(() => $("tagMergeSourceSuggestions")?.classList.add("hidden"), 140);
    };
    $("tagMergeTarget").oninput = syncMergeChipSelection;
    syncMergeChipSelection();
    renderSourceSuggestions();
  }

  function sourceInputQuery(value) {
    const parts = String(value || "").split(/[,\uFF0C;\uFF1B\r\n]/);
    return text(parts[parts.length - 1]).toLocaleLowerCase();
  }

  function appendMergeSource(name) {
    const input = $("tagMergeSource");
    const currentValue = input.value;
    const hasSeparator = /[,\uFF0C;\uFF1B\r\n]/.test(currentValue);
    const knownNames = new Set(state.managedTags.map((tag) => tag.name));
    const parsed = parseMergeSources(currentValue);
    const parts = currentValue.split(/[,\uFF0C;\uFF1B\r\n]/);
    const lastPart = text(parts[parts.length - 1]);
    const completedParts = parts.slice(0, -1).map(text).filter(Boolean);
    if (lastPart && knownNames.has(lastPart)) completedParts.push(lastPart);
    const current = hasSeparator
      ? completedParts
      : parsed.every((item) => knownNames.has(item)) ? parsed : [];
    if (!current.includes(name)) current.push(name);
    input.value = uniqueExactTags(current).join(", ") + ", ";
    input.focus();
    syncMergeChipSelection();
    renderSourceSuggestions();
  }

  function renderSourceSuggestions() {
    const host = $("tagMergeSourceSuggestions");
    const input = $("tagMergeSource");
    if (!host || !input) return;
    const selected = new Set(parseMergeSources(input.value));
    const query = sourceInputQuery(input.value);
    const matches = state.managedTags
      .filter((tag) => !selected.has(tag.name))
      .filter((tag) => !query || tag.name.toLocaleLowerCase().includes(query))
      .slice(0, 10);
    host.innerHTML = matches.length ? `
      <span class="tag-input-suggestion-label">匹配标签</span>
      ${matches.map((tag) => `
        <button type="button" class="tag-input-suggestion" data-source-suggestion="${escapeAttr(tag.name)}">
          <span>${escapeHtml(tag.name)}</span><b>${tag.count}</b>
        </button>`).join("")}` : "";
    host.classList.toggle("hidden", !matches.length);
    host.querySelectorAll("[data-source-suggestion]").forEach((button) => {
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", () => appendMergeSource(button.dataset.sourceSuggestion));
    });
  }

  function syncMergeChipSelection() {
    const selected = new Set(parseMergeSources($("tagMergeSource").value));
    const target = text($("tagMergeTarget").value);
    $("tagMergeSuggestions")?.querySelectorAll("[data-merge-source]").forEach((button) => {
      const source = button.dataset.mergeSource;
      const suggestedTarget = button.dataset.mergeTarget;
      button.classList.toggle("selected", source !== suggestedTarget && selected.has(source));
      button.classList.toggle("chosen-target", source === suggestedTarget && target === suggestedTarget);
    });
  }

  async function openTagManager() {
    if (!tagMergeSupported()) {
      setMessage("当前 Eagle 版本不支持标签合并，需要 Eagle 4.0 build18 或更高版本。", "warning");
      return;
    }
    try {
      $("tagManagerButton").disabled = true;
      await readManagedTags();
      renderTagManager();
      $("tagManagerModal").classList.remove("hidden");
      requestAnimationFrame(() => $("tagMergeSource").focus());
    } catch (error) {
      setMessage(`读取标签列表失败：${error?.message || error}`, "error");
    } finally {
      $("tagManagerButton").disabled = false;
    }
  }

  function closeTagManager() {
    if (state.tagManagerBusy) return;
    $("tagManagerModal").classList.add("hidden");
  }

  function parseMergeSources(value) {
    const input = text(value);
    if (!input) return [];
    const knownNames = new Set(state.managedTags.map((tag) => tag.name));
    const separated = input
      .split(/[,\uFF0C;\uFF1B\r\n]+/)
      .map(text)
      .filter(Boolean);
    if (separated.length > 1) return uniqueExactTags(separated);
    if (knownNames.has(input)) return [input];

    // Spaces are accepted only when every token is an existing tag. This
    // keeps tags such as "角色 PV" usable as one label.
    const spaced = input.split(/\s+/).map(text).filter(Boolean);
    return spaced.length > 1 && spaced.every((name) => knownNames.has(name))
      ? uniqueExactTags(spaced)
      : [input];
  }

  function applyLocalTagMerge(sources, target) {
    const sourceSet = new Set(sources);
    const replaceTags = (tags) => cleanTags(safeArray(tags).map((tag) => (
      sourceSet.has(tag) ? target : tag
    )));
    const replaceItem = (item) => ({ ...item, tags: replaceTags(item.tags) });

    state.allItems = state.allItems.map(replaceItem);
    state.sourceItems = state.sourceItems.map(replaceItem);
    state.groups = state.groups.map((group) => ({
      ...group,
      tags: replaceTags(group.tags),
    }));
    if (sourceSet.has(state.activeTag)) state.activeTag = target;

    const counts = new Map();
    state.allItems.forEach((item) => item.tags.forEach((tag) => {
      counts.set(tag, (counts.get(tag) || 0) + 1);
    }));
    state.managedTags = [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => (
        b.count - a.count || a.name.localeCompare(b.name, "zh-CN")
      ));

    writeCache();
    renderGroupOptions();
    buildGraph();
    renderAll();
    renderTagManager();
  }

  async function mergeTags() {
    if (state.tagManagerBusy) return;
    const sources = parseMergeSources($("tagMergeSource").value);
    const target = text($("tagMergeTarget").value);
    if (!sources.length || !target) throw new Error("请填写待合并标签和保留标签");
    if (sources.includes(target)) {
      throw new Error("待合并标签不能包含保留标签");
    }
    const missing = sources.filter((source) => !state.managedTags.some((tag) => tag.name === source));
    if (missing.length) {
      throw new Error(`找不到源标签：${missing.map((source) => `“${source}”`).join("、")}`);
    }
    const shouldConfirm = $("tagMergeConfirmToggle")?.checked !== false;
    if (shouldConfirm) {
      const approved = window.confirm(
        `确认将 ${sources.map((source) => `“${source}”`).join("、")} 合并到 “${target}” 吗？\n\n该操作会更新所有使用源标签的项目、标签群组、常用标签和历史标签，且无法撤销。`,
      );
      if (!approved) return;
    }
    setTagManagerBusy(true);
    const completed = [];
    let totalAffected = 0;
    state.suppressLibraryRefreshUntil = Date.now() + 5000;
    try {
      for (const source of sources) {
        const result = await eagle.tag.merge({ source, target });
        completed.push(source);
        totalAffected += Number(result?.affectedItems || 0);
      }
      applyLocalTagMerge(completed, target);
      $("tagMergeSource").value = "";
      $("tagMergeTarget").value = target;
      $("tagMergeStatus").textContent = `已合并 ${completed.length} 个标签到 “${target}”，面板保持打开，可继续操作。`;
      $("tagMergeSource").focus();
      setMessage(`已将 ${completed.map((source) => `“${source}”`).join("、")} 合并到 “${target}”，同步更新 ${totalAffected} 个项目。`, "success");
    } catch (error) {
      if (completed.length) {
        applyLocalTagMerge(completed, target);
        $("tagMergeSource").value = "";
        $("tagMergeTarget").value = target;
        $("tagMergeStatus").textContent = `已完成 ${completed.length}/${sources.length} 个标签；其余操作失败，面板保持打开。`;
      }
      throw new Error(
        completed.length
          ? `部分合并完成（${completed.length}/${sources.length}），${error?.message || error}`
          : (error?.message || error),
      );
    } finally {
      setTagManagerBusy(false);
    }
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
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh-CN"));
    const candidateTags = new Set(state.tags.map((tag) => tag.name));
    const edgeCounts = new Map();
    state.sourceItems.forEach((item) => {
      const tags = item.tags
        .filter((tag) => candidateTags.has(tag))
        .sort((a, b) => a.localeCompare(b, "zh-CN"));
      for (let i = 0; i < tags.length; i += 1) {
        for (let j = i + 1; j < tags.length; j += 1) {
          const key = `${tags[i]}\u0000${tags[j]}`;
          edgeCounts.set(key, (edgeCounts.get(key) || 0) + 1);
        }
      }
    });
    const relationshipScores = new Map();
    const allEdges = [...edgeCounts.entries()]
      .map(([key, count]) => {
        const [source, target] = key.split("\u0000");
        relationshipScores.set(source, (relationshipScores.get(source) || 0) + count);
        relationshipScores.set(target, (relationshipScores.get(target) || 0) + count);
        return { source, target, count };
      })
      .sort((a, b) => b.count - a.count || a.source.localeCompare(b.source, "zh-CN"));
    state.tags.forEach((tag) => {
      tag.relationshipScore = relationshipScores.get(tag.name) || 0;
      tag.importance = tag.count * 2 + Math.sqrt(tag.relationshipScore) * 3;
    });
    state.tags.sort((a, b) => (
      b.importance - a.importance
      || b.relationshipScore - a.relationshipScore
      || b.count - a.count
      || a.name.localeCompare(b.name, "zh-CN")
    ));
    state.edges = allEdges;
    state.edgeIndex = new Map();
    allEdges.forEach((edge) => {
      if (!state.edgeIndex.has(edge.source)) state.edgeIndex.set(edge.source, []);
      if (!state.edgeIndex.has(edge.target)) state.edgeIndex.set(edge.target, []);
      state.edgeIndex.get(edge.source).push(edge);
      state.edgeIndex.get(edge.target).push(edge);
    });
    if (state.activeTag && !state.tags.some((tag) => tag.name === state.activeTag)) state.activeTag = "";
  }

  function renderAll() {
    renderStats();
    renderTagList();
    renderTitleTagList();
    renderGraph();
  }

  function renderStats() {
    const tagged = state.sourceItems.filter((item) => item.tags.length).length;
    $("statsLine").textContent = `${state.sourceItems.length} 个项目 · ${tagged} 个有标签 · ${state.tags.length} 个实际标签`;
    $("tagCount").textContent = String(state.tags.length);
    updateShowMoreButton();
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
    $("tagList").querySelectorAll("[data-tag]").forEach((button) => button.addEventListener("click", () => {
      selectTag(button.dataset.tag).catch((error) => setMessage(`筛选失败：${error?.message || error}`, "warning"));
    }));
  }

  function renderTitleTagList() {
    const section = $("titleTagSection");
    if (!section) return;
    const tag = state.tags.find((candidate) => candidate.name === state.activeTag);
    if (!tag) {
      section.classList.add("hidden");
      $("titleTagList").innerHTML = "";
      return;
    }
    const items = getTagResultItems(tag);
    section.classList.remove("hidden");
    $("titleTagCount").textContent = String(items.length);
    $("titleTagList").innerHTML = items.length ? items.map((item) => `
      <div class="title-tag-row" title="${escapeAttr(item.name)}">
        <strong>${escapeHtml(item.name)}</strong>
        <span>${escapeHtml(item.tags.join(" · "))}</span>
      </div>
    `).join("") : '<div class="empty">当前范围内没有对应项目。</div>';
  }

  function getTagResultItems(tag) {
    if (!tag) return [];
    const itemIds = new Set(tag.itemIds);
    const folderIds = selectedFolderIds();
    const restrictToFolder = state.scope === "folder" && folderIds.size;
    return state.sourceItems.filter((item) => (
      itemIds.has(item.id) && (!restrictToFolder || item.folders.some((id) => folderIds.has(id)))
    ));
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
    stopNodeMotion();
    $("graphHost").innerHTML = `<div class="empty graph-empty">${escapeHtml(message)}</div>`;
    $("tagList").innerHTML = '<div class="empty">暂无标签数据。</div>';
  }

  function renderGraph() {
    const rankedNames = filteredTagNames();
    const names = visibleTagNames(rankedNames);
    if (state.activeTag && rankedNames.includes(state.activeTag) && !names.includes(state.activeTag)) {
      names[names.length - 1] = state.activeTag;
    }
    const nodes = names.map((name) => state.tags.find((tag) => tag.name === name)).filter(Boolean);
    if (!nodes.length) {
      renderEmpty(state.sourceItems.length ? "当前范围内没有实际使用中的标签。" : "当前范围没有项目。");
      return;
    }
    const nodeMap = new Map(nodes.map((node) => [node.name, node]));
    const validEdges = getVisibleEdges(nodes, nodeMap);
    const positions = layoutNodes(nodes, validEdges);
    const adjacency = buildAdjacency(nodes, validEdges);
    state.visibleAdjacency = adjacency;
    state.primaryEdgeKeys = getPrimaryEdgeKeys(nodes, validEdges);
    const maxCount = Math.max(1, ...nodes.map((node) => node.count));
    state.visibleEdges = validEdges;
    state.visibleEdgeIndex = buildEdgeIndex(validEdges);
    state.graphPositions = positions;
    state.graphMaxEdge = Math.max(1, ...validEdges.map((edge) => edge.count));
    const active = state.activeTag;
    const nodeHtml = nodes.map((node, index) => {
      const point = positions.get(node.name);
      const ratio = node.count / maxCount;
      const size = nodeSize(node, ratio, point.degree);
      const label = displayTagName(node.name);
      const connected = !active || active === node.name || adjacency.get(active)?.has(node.name);
      return `<g class="graph-node ${active === node.name ? "active" : ""} ${connected ? "" : "dim"}" data-tag="${escapeAttr(node.name)}" data-node-width="${size.width}" data-node-height="${size.height}" transform="translate(${point.x} ${point.y})" tabindex="0" role="button" aria-label="${escapeAttr(`${node.name}，${node.count} 个项目`)}" style="--node-accent:${colorFor(node.name)}">
        <g class="node-float" style="--float-delay:${(-(index % 7) * .55).toFixed(2)}s;--float-duration:${(5.2 + (index % 4) * .7).toFixed(1)}s">
          <rect class="sticker-shadow" x="${(-size.width / 2 + 3).toFixed(1)}" y="${(-size.height / 2 + 5).toFixed(1)}" width="${size.width}" height="${size.height}" rx="13"/>
          <rect class="sticker" x="${(-size.width / 2).toFixed(1)}" y="${(-size.height / 2).toFixed(1)}" width="${size.width}" height="${size.height}" rx="13"/>
          <rect class="sticker-inner" x="${(-size.width / 2 + 4).toFixed(1)}" y="${(-size.height / 2 + 4).toFixed(1)}" width="${(size.width - 8).toFixed(1)}" height="${(size.height - 8).toFixed(1)}" rx="10"/>
          <rect class="sticker-accent" x="${(-size.width / 2 + 9).toFixed(1)}" y="${(-size.height / 2 + 10).toFixed(1)}" width="4" height="${(size.height - 20).toFixed(1)}" rx="2"/>
          <text class="node-label" x="0" y="-2">${escapeHtml(label)}</text>
          <text class="node-count" x="${(size.width / 2 - 13).toFixed(1)}" y="${(size.height / 2 - 10).toFixed(1)}">${escapeHtml(`${node.count} 个`)}</text>
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
          <g class="graph-edges"></g><g class="graph-nodes">${nodeHtml}</g>
        </g>
      </svg>`;
    renderEdgeLayer($("graphSvg"), state.activeTag);
    bindGraphEvents();
    startNodeMotion();
  }

  function visibleTagNames(rankedNames) {
    const total = rankedNames.length;
    const shown = Math.min(state.visibleLimit, MAX_NODE_LIMIT, total);
    if (!shown) return [];
    state.visibleOffset = ((state.visibleOffset % total) + total) % total;
    return Array.from(
      { length: shown },
      (_, index) => rankedNames[(state.visibleOffset + index) % total],
    );
  }

  function getVisibleEdges(nodes, nodeMap) {
    const names = nodes.map((node) => node.name);
    const seen = new Set();
    const visibleEdges = [];
    names.forEach((name) => {
      (state.edgeIndex.get(name) || []).forEach((edge) => {
        if (!nodeMap.has(edge.source) || !nodeMap.has(edge.target)) return;
        const key = `${edge.source}\u0000${edge.target}`;
        if (seen.has(key)) return;
        seen.add(key);
        visibleEdges.push(edge);
      });
    });
    return visibleEdges;
  }

  function buildAdjacency(nodes, edges) {
    const adjacency = new Map(nodes.map((node) => [node.name, new Set()]));
    edges.forEach((edge) => {
      adjacency.get(edge.source)?.add(edge.target);
      adjacency.get(edge.target)?.add(edge.source);
    });
    return adjacency;
  }

  function buildEdgeIndex(edges) {
    const index = new Map();
    edges.forEach((edge) => {
      if (!index.has(edge.source)) index.set(edge.source, []);
      if (!index.has(edge.target)) index.set(edge.target, []);
      index.get(edge.source).push(edge);
      index.get(edge.target).push(edge);
    });
    return index;
  }

  function edgeKey(edge) {
    return `${edge.source}\u0000${edge.target}`;
  }

  function getPrimaryEdgeKeys(nodes, edges) {
    if (!edges.length) return new Set();
    const ranked = [...edges].sort((a, b) => (
      b.count - a.count
      || a.source.localeCompare(b.source, "zh-CN")
      || a.target.localeCompare(b.target, "zh-CN")
    ));
    const limit = Math.min(ranked.length, Math.max(18, Math.min(72, Math.ceil(nodes.length * 1.35))));
    const keys = new Set(ranked.slice(0, limit).map(edgeKey));
    const strongestByNode = new Map();
    ranked.forEach((edge) => {
      if (!strongestByNode.has(edge.source)) strongestByNode.set(edge.source, edge);
      if (!strongestByNode.has(edge.target)) strongestByNode.set(edge.target, edge);
    });
    strongestByNode.forEach((edge) => keys.add(edgeKey(edge)));
    return keys;
  }

  function renderEdgeLayer(svg, focusTag = "") {
    const layer = svg?.querySelector(".graph-edges");
    if (!layer) return;
    const edges = focusTag
      ? safeArray(state.visibleEdgeIndex.get(focusTag))
      : state.visibleEdges.filter((edge) => state.primaryEdgeKeys.has(edgeKey(edge)));
    layer.innerHTML = edges.map((edge) => edgeMarkup(edge, Boolean(focusTag))).join("");
  }

  function edgeMarkup(edge, focused) {
    const source = state.graphPositions.get(edge.source);
    const target = state.graphPositions.get(edge.target);
    if (!source || !target) return "";
    return `<line class="graph-edge ${focused ? "focus" : "primary"}" data-source="${escapeAttr(edge.source)}" data-target="${escapeAttr(edge.target)}" x1="${source.x.toFixed(2)}" y1="${source.y.toFixed(2)}" x2="${target.x.toFixed(2)}" y2="${target.y.toFixed(2)}" stroke-width="${(1 + edge.count / state.graphMaxEdge * 4).toFixed(2)}"/>`;
  }

  function updateShowMoreButton() {
    const button = $("showMoreTagsButton");
    if (!button) return;
    const available = filteredTagNames().length;
    const shown = Math.min(state.visibleLimit, available);
    const maximum = Math.min(MAX_NODE_LIMIT, available);
    button.disabled = shown >= maximum;
    button.textContent = shown >= maximum
      ? (available > maximum ? `已显示 ${maximum}/${available}` : `已显示 ${shown}`)
      : `显示更多 (${shown}/${available})`;
    updateRefreshTagsButton();
  }

  function updateRefreshTagsButton() {
    const button = $("refreshTagsButton");
    if (!button) return;
    const available = filteredTagNames().length;
    const shown = Math.min(state.visibleLimit, MAX_NODE_LIMIT, available);
    button.disabled = available <= shown;
    button.textContent = button.disabled ? "已展示全部" : `换一批 (${shown}/${available})`;
  }

  function layoutNodes(nodes, visibleEdges) {
    const center = GRAPH_SIZE / 2;
    const positions = new Map();
    const visibleNames = new Set(nodes.map((node) => node.name));
    const degreeByName = new Map(nodes.map((node) => [node.name, 0]));
    visibleEdges.forEach((edge) => {
      if (visibleNames.has(edge.source)) degreeByName.set(edge.source, (degreeByName.get(edge.source) || 0) + 1);
      if (visibleNames.has(edge.target)) degreeByName.set(edge.target, (degreeByName.get(edge.target) || 0) + 1);
    });
    const maxCount = Math.max(1, ...nodes.map((node) => node.count));
    const sorted = [...nodes].sort((a, b) => (
      b.importance - a.importance
      || b.count - a.count
      || a.name.localeCompare(b.name, "zh-CN")
    ));
    const sizes = new Map(sorted.map((node) => {
      const degree = degreeByName.get(node.name) || 0;
      return [node.name, nodeSize(node, node.count / maxCount, degree)];
    }));
    const occupied = [];
    const automatic = [];

    sorted.forEach((node) => {
      const saved = state.nodePositions.get(node.name);
      if (!state.manualNodePositions.has(node.name) || !Number.isFinite(saved?.x) || !Number.isFinite(saved?.y)) return;
      const point = {
        x: saved.x,
        y: saved.y,
        degree: degreeByName.get(node.name) || 0,
      };
      positions.set(node.name, point);
      occupied.push({ name: node.name, ...point, ...sizes.get(node.name), manual: true });
    });

    let ring = 0;
    let slot = 0;
    let ringCapacity = 1;
    let radius = 0;
    sorted.forEach((node) => {
      if (positions.has(node.name)) return;
      if (slot >= ringCapacity) {
        ring += 1;
        slot = 0;
        radius = ring === 1 ? 145 : 145 + (ring - 1) * 112;
        ringCapacity = ring === 0 ? 1 : Math.max(5, Math.floor((Math.PI * 2 * radius) / 155));
      }
      const angle = ring === 0
        ? -Math.PI / 2
        : -Math.PI / 2 + (slot / ringCapacity) * Math.PI * 2 + (ring % 2 ? 0 : Math.PI / ringCapacity);
      const point = {
        x: center + Math.cos(angle) * radius,
        y: center + Math.sin(angle) * radius,
        degree: degreeByName.get(node.name) || 0,
      };
      const entry = { name: node.name, ...point, ...sizes.get(node.name), manual: false, seedX: point.x, seedY: point.y };
      positions.set(node.name, point);
      occupied.push(entry);
      automatic.push(entry);
      slot += 1;
    });

    separateAutomaticNodes(occupied, automatic, positions);
    positions.forEach((point, name) => {
      state.nodePositions.set(name, { x: point.x, y: point.y });
    });
    return positions;
  }

  function separateAutomaticNodes(occupied, automatic, positions) {
    const gap = 22;
    for (let pass = 0; pass < 42; pass += 1) {
      let moved = false;
      for (let i = 0; i < occupied.length; i += 1) {
        for (let j = i + 1; j < occupied.length; j += 1) {
          const first = occupied[i];
          const second = occupied[j];
          const overlapX = (first.width + second.width) / 2 + gap - Math.abs(second.x - first.x);
          const overlapY = (first.height + second.height) / 2 + gap - Math.abs(second.y - first.y);
          if (overlapX <= 0 || overlapY <= 0) continue;

          const moveFirst = !first.manual;
          const moveSecond = !second.manual;
          if (!moveFirst && !moveSecond) continue;
          const horizontal = overlapX < overlapY;
          const direction = horizontal
            ? (second.x >= first.x ? 1 : -1)
            : (second.y >= first.y ? 1 : -1);
          const amount = (horizontal ? overlapX : overlapY) + .6;
          if (moveFirst && moveSecond) {
            if (horizontal) {
              first.x -= direction * amount / 2;
              second.x += direction * amount / 2;
            } else {
              first.y -= direction * amount / 2;
              second.y += direction * amount / 2;
            }
          } else {
            const target = moveFirst ? first : second;
            const sign = target === first ? -direction : direction;
            if (horizontal) target.x += sign * amount;
            else target.y += sign * amount;
          }
          moved = true;
        }
      }
      automatic.forEach((entry) => {
        entry.x += (entry.seedX - entry.x) * .009;
        entry.y += (entry.seedY - entry.y) * .009;
      });
      if (!moved) break;
    }
    occupied.forEach((entry) => {
      const point = positions.get(entry.name);
      if (!point) return;
      point.x = entry.x;
      point.y = entry.y;
    });
  }

  function nodeSize(node, ratio, degree) {
    const labelWidth = [...displayTagName(node.name)].reduce((total, char) => (
      total + (char.charCodeAt(0) > 255 ? 14 : 8)
    ), 0);
    return {
      width: Math.round(clamp(86 + labelWidth + Math.min(24, degree * 2), 94, 202)),
      height: Math.round(48 + ratio * 12 + Math.min(8, degree * 0.7)),
    };
  }

  function displayTagName(name) {
    const chars = [...text(name)];
    return chars.length > 13 ? `${chars.slice(0, 12).join("")}...` : chars.join("");
  }

  function bindGraphEvents() {
    const svg = $("graphSvg");
    const viewport = $("graphViewport");
    if (!svg) return;
    let edgeList = [...svg.querySelectorAll(".graph-edge")];
    let drag = null;
    svg.addEventListener("pointerdown", (event) => {
      if (event.target.closest(".graph-node")) return;
      const point = getSvgPoint(svg, event);
      drag = { x: point.x, y: point.y, panX: state.panX, panY: state.panY };
      svg.classList.add("dragging");
      svg.setPointerCapture?.(event.pointerId);
    });
    svg.addEventListener("pointermove", (event) => {
      if (!drag) return;
      if (drag.type === "node") {
        moveNode(svg, event);
        return;
      }
      const point = getSvgPoint(svg, event);
      state.panX = drag.panX + point.x - drag.x;
      state.panY = drag.panY + point.y - drag.y;
      applyTransform(viewport);
    });
    const stop = () => {
      if (drag?.type === "node") {
        drag.node.classList.remove("node-dragging");
        drag.node.dataset.dragMoved = drag.moved ? "1" : "0";
      }
      drag = null;
      svg.classList.remove("dragging");
    };
    svg.addEventListener("pointerup", stop);
    svg.addEventListener("pointercancel", stop);
    svg.addEventListener("wheel", (event) => {
      event.preventDefault();
      const pointer = getSvgPoint(svg, event);
      const pointerX = pointer.x;
      const pointerY = pointer.y;
      const baseTarget = Number.isFinite(state.zoomTarget) ? state.zoomTarget : state.zoom;
      const targetZoom = clamp(baseTarget * (event.deltaY < 0 ? 1.12 : 0.89), 0.62, 2.4);
      // Calculate the anchor from the transform currently visible on screen.
      // Using the pending target transform makes repeated wheel events drift away
      // from the cursor while the easing animation is still running.
      const worldX = (pointerX - state.panX) / Math.max(.001, state.zoom);
      const worldY = (pointerY - state.panY) / Math.max(.001, state.zoom);
      state.zoomTarget = targetZoom;
      state.panTargetX = pointerX - worldX * targetZoom;
      state.panTargetY = pointerY - worldY * targetZoom;
      clampTargetPan();
      startZoomMotion();
    }, { passive: false });
    svg.querySelectorAll(".graph-node").forEach((node) => {
      node.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        edgeList = [...svg.querySelectorAll(".graph-edge")];
        const point = state.nodePositions.get(node.dataset.tag);
        if (!point) return;
        const pointer = getWorldPoint(svg, event);
        drag = {
          type: "node",
          node,
          tag: node.dataset.tag,
          startX: pointer.x,
          startY: pointer.y,
          originX: point.x,
          originY: point.y,
          moved: false,
        };
        node.dataset.dragMoved = "0";
        node.classList.add("node-dragging");
        node.setPointerCapture?.(event.pointerId);
      });
      node.addEventListener("click", () => {
        if (node.dataset.dragMoved === "1") {
          node.dataset.dragMoved = "0";
          return;
        }
        selectTag(node.dataset.tag).catch((error) => setMessage(`筛选失败：${error?.message || error}`, "warning"));
      });
      node.addEventListener("mouseenter", () => highlightHover(svg, node.dataset.tag));
      node.addEventListener("mouseleave", () => updateHighlight(svg, state.activeTag));
      node.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          selectTag(node.dataset.tag).catch((error) => setMessage(`筛选失败：${error?.message || error}`, "warning"));
        }
      });
    });

    function moveNode(graph, event) {
      if (!drag || drag.type !== "node") return;
      const pointer = getWorldPoint(graph, event);
      const next = {
        x: drag.originX + pointer.x - drag.startX,
        y: drag.originY + pointer.y - drag.startY,
      };
      if (Math.abs(next.x - drag.originX) > .5 || Math.abs(next.y - drag.originY) > .5) drag.moved = true;
      state.nodePositions.set(drag.tag, next);
      state.graphPositions.set(drag.tag, next);
      state.manualNodePositions.add(drag.tag);
      drag.node.setAttribute("transform", `translate(${next.x.toFixed(2)} ${next.y.toFixed(2)})`);
      edgeList.forEach((edge) => {
        if (edge.dataset.source === drag.tag) {
          edge.setAttribute("x1", next.x.toFixed(2));
          edge.setAttribute("y1", next.y.toFixed(2));
        }
        if (edge.dataset.target === drag.tag) {
          edge.setAttribute("x2", next.x.toFixed(2));
          edge.setAttribute("y2", next.y.toFixed(2));
        }
      });
    }
  }

  function getSvgPoint(svg, event) {
    const point = svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const matrix = svg.getScreenCTM();
    return matrix ? point.matrixTransform(matrix.inverse()) : { x: 0, y: 0 };
  }

  function getWorldPoint(svg, event) {
    const point = getSvgPoint(svg, event);
    return {
      x: (point.x - state.panX) / Math.max(.001, state.zoom),
      y: (point.y - state.panY) / Math.max(.001, state.zoom),
    };
  }

  function floatSeed(name) {
    let hash = 0;
    for (const char of text(name)) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
    return Math.abs(hash % 1000) / 1000;
  }

  function stopNodeMotion() {
    if (state.floatFrame) cancelAnimationFrame(state.floatFrame);
    state.floatFrame = 0;
    state.floatStartedAt = 0;
  }

  function startNodeMotion() {
    // Floating is handled by CSS so animation does not rewrite every edge on each frame.
  }

  function highlightHover(svg, name) {
    const adjacency = state.visibleAdjacency;
    svg.querySelectorAll(".graph-node").forEach((node) => {
      const connected = node.dataset.tag === name || adjacency.get(name)?.has(node.dataset.tag);
      node.classList.toggle("hovered", node.dataset.tag === name);
      node.classList.toggle("connected", connected && node.dataset.tag !== name);
      node.classList.toggle("dim", !connected);
    });
    renderEdgeLayer(svg, name);
  }

  function updateHighlight(svg, active) {
    if (!svg) return;
    const adjacency = state.visibleAdjacency;
    svg.querySelectorAll(".graph-node").forEach((node) => {
      const connected = !active || node.dataset.tag === active || adjacency.get(active)?.has(node.dataset.tag);
      node.classList.remove("hovered", "connected");
      node.classList.toggle("dim", !connected);
      node.classList.toggle("active", node.dataset.tag === active);
    });
    renderEdgeLayer(svg, active);
  }

  async function selectTag(name) {
    state.activeTag = name === state.activeTag ? "" : name;
    const tag = state.tags.find((candidate) => candidate.name === state.activeTag);
    const selectedName = state.activeTag;
    $("selectionTitle").textContent = state.activeTag || "未选择标签";
    $("selectionDetail").textContent = tag
      ? `${getTagResultItems(tag).length} 个项目 · ${smartFolderSupported() ? "正在同步到 Eagle 智能收藏夹" : "仅在插件内筛选"}`
      : "点击节点或列表标签，查看对应项目标题和 tags。";
    updateTagListSelection();
    renderTitleTagList();
    updateHighlight($("graphSvg"), state.activeTag);
    const synced = await applySmartFolderFilter(state.activeTag);
    if (tag && state.activeTag === selectedName) {
      $("selectionDetail").textContent = `${getTagResultItems(tag).length} 个项目 · ${synced ? "已同步到 Eagle 智能收藏夹" : "仅在插件内筛选"}`;
    }
  }

  function updateTagListSelection() {
    $("tagList").querySelectorAll("[data-tag]").forEach((button) => {
      button.classList.toggle("active", button.dataset.tag === state.activeTag);
    });
  }

  function smartFolderSupported() {
    return Boolean(
      window.eagle?.smartFolder?.create
      && window.eagle?.smartFolder?.getAll
      && (!Number.isFinite(Number(eagle.app?.build)) || Number(eagle.app.build) >= 22)
    );
  }

  async function getPluginSmartFolder() {
    if (!smartFolderSupported()) {
      throw new Error("需要 Eagle 4.0 build22 或更高版本才能使用智能收藏夹筛选");
    }
    const savedId = text(localStorage.getItem(SMART_FOLDER_ID_KEY));
    if (savedId && typeof eagle.smartFolder.getById === "function") {
      try {
        const saved = await eagle.smartFolder.getById(savedId);
        if (saved) return saved;
      } catch {
        localStorage.removeItem(SMART_FOLDER_ID_KEY);
      }
    }
    const all = safeArray(await eagle.smartFolder.getAll());
    const existing = all.find((folder) => (
      text(folder.description).includes(SMART_FOLDER_MARKER)
    ));
    if (existing) {
      localStorage.setItem(SMART_FOLDER_ID_KEY, text(existing.id));
      return existing;
    }
    const created = await eagle.smartFolder.create({
      name: SMART_FOLDER_NAME,
      description: `${SMART_FOLDER_MARKER}\n由“标签分析”插件创建并维护，用于显示当前选择的标签。`,
      iconColor: window.eagle?.smartFolder?.IconColor?.Pink || "pink",
      conditions: await buildTagConditions(""),
    });
    localStorage.setItem(SMART_FOLDER_ID_KEY, text(created.id));
    return created;
  }

  async function buildTagConditions(tagNames) {
    const schema = typeof eagle.smartFolder?.getRules === "function"
      ? await eagle.smartFolder.getRules()
      : {};
    const names = Array.isArray(tagNames)
      ? uniqueExactTags(tagNames)
      : (text(tagNames) ? [text(tagNames)] : []);
    if (!names.length) return buildMatchAllConditions(schema);

    // Eagle's tags property is an array. For array tags, "union" means the
    // item contains at least one of the supplied tag names.
    const property = "tags";
    const methods = safeArray(schema?.[property]?.methods);
    const method = methods.includes("union") || !methods.length ? "union" : (
      methods.includes("intersection") ? "intersection" : "equal"
    );
    if (typeof eagle.smartFolder?.rule === "function" && eagle.smartFolder?.Condition?.create) {
      const builder = eagle.smartFolder.rule(property);
      if (typeof builder?.[method] === "function") {
        const rules = names.map((name) => builder[method]([name]));
        return [eagle.smartFolder.Condition.create("AND", rules)];
      }
    }
    return [{
      rules: names.map((name) => ({ property, method, value: [name] })),
      match: "AND",
    }];
  }

  function buildMatchAllConditions(schema) {
    const nameSchema = schema?.name || {};
    const methods = safeArray(nameSchema.methods);
    const method = methods.includes("contain") ? "contain" : (
      methods.includes("notEmpty") ? "notEmpty" : (
        methods.includes("not_empty") ? "not_empty" : "contain"
      )
    );
    // Eagle rejects an empty conditions array. A name-contains-empty rule is
    // the most portable "match everything" condition across Eagle builds.
    return [{
      rules: [{
        property: "name",
        method,
        ...(method === "contain" ? { value: "" } : {}),
      }],
      match: "AND",
    }];
  }

  async function openPluginSmartFolder(folder) {
    let opened = false;
    if (typeof eagle.smartFolder?.open === "function") {
      await eagle.smartFolder.open(folder.id);
      opened = true;
    } else if (typeof folder?.open === "function") {
      await folder.open();
      opened = true;
    }
    if (typeof eagle.app?.show === "function") await eagle.app.show();
    return opened;
  }

  async function refreshPluginSmartFolderView(folder) {
    // Re-fetch after save so Eagle receives the current SmartFolder instance.
    let current = folder;
    if (typeof eagle.smartFolder?.getById === "function" && folder?.id) {
      try {
        current = await eagle.smartFolder.getById(folder.id) || folder;
      } catch {
        current = folder;
      }
    }
    const opened = await openPluginSmartFolder(current);
    if (!opened) return false;
    // Re-opening after the save gives the main Eagle list a chance to replace
    // an already-open smart-folder result instead of keeping its old rows.
    await new Promise((resolve) => setTimeout(resolve, 80));
    await openPluginSmartFolder(current);
    return true;
  }

  async function applySmartFolderFilter(tagName) {
    if (!smartFolderSupported()) {
      setMessage("当前 Eagle 未提供智能收藏夹 API，标签只在插件内高亮显示。", "warning");
      return false;
    }
    const folder = await getPluginSmartFolder();
    const conditions = await buildTagConditions(tagName);
    if (!Array.isArray(conditions) || conditions.length === 0) {
      throw new Error("无法生成 Eagle 智能收藏夹条件");
    }
    folder.conditions = conditions;
    const savedFolder = await folder.save();
    const openedFolder = savedFolder || folder;
    const opened = await refreshPluginSmartFolderView(openedFolder);
    if (tagName) {
      setMessage(
        opened
          ? `已在“${SMART_FOLDER_NAME}”中筛选标签：${tagName}`
          : `已更新“${SMART_FOLDER_NAME}”为标签：${tagName}；当前 Eagle 版本未公开自动跳转接口，请在侧栏打开该智能收藏夹。`,
        opened ? "success" : "warning",
      );
    } else {
      setMessage(
        opened
          ? `已清除“${SMART_FOLDER_NAME}”的筛选条件。`
          : `已清除“${SMART_FOLDER_NAME}”的筛选条件。`,
        "success",
      );
    }
    return true;
  }

  function clampPan() {
    // Canvas positions are intentionally unbounded: users can arrange a large graph freely.
  }

  function clampTargetPan() {
    // Keep target pan unbounded as well, so eased zoom does not pull the canvas back.
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
    if (state.zoomFrame) {
      cancelAnimationFrame(state.zoomFrame);
      state.zoomFrame = 0;
    }
    renderGraph();
  }

  function arrangeGraph() {
    state.nodePositions = new Map();
    state.manualNodePositions.clear();
    renderGraph();
    setMessage("已按标签重要性自动整理当前画布。", "success");
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

  async function callWindowApi(method) {
    if (typeof window.eagle?.window?.[method] !== "function") {
      setMessage("当前环境不支持窗口控制。", "warning");
      return;
    }
    try {
      await window.eagle.window[method]();
    } catch (error) {
      setMessage(`窗口操作失败：${error?.message || error}`, "warning");
    }
  }

  async function toggleWindowMaximize() {
    if (typeof window.eagle?.window?.isMaximized !== "function") {
      setMessage("当前环境不支持窗口控制。", "warning");
      return;
    }
    try {
      const maximized = await window.eagle.window.isMaximized();
      await callWindowApi(maximized ? "unmaximize" : "maximize");
    } catch (error) {
      setMessage(`窗口操作失败：${error?.message || error}`, "warning");
    }
  }

  function bindControls() {
    $("refreshButton").addEventListener("click", () => loadData(true));
    $("tagManagerButton").addEventListener("click", () => {
      openTagManager().catch((error) => setMessage(`打开标签管理失败：${error?.message || error}`, "error"));
    });
    $("tagManagerCloseButton").addEventListener("click", closeTagManager);
    $("tagManagerModal").addEventListener("click", (event) => {
      if (event.target === $("tagManagerModal")) closeTagManager();
    });
    $("tagMergeForm").addEventListener("submit", (event) => {
      event.preventDefault();
      mergeTags().catch((error) => {
        setTagManagerBusy(false);
        setMessage(`合并标签失败：${error?.message || error}`, "error");
        $("tagMergeStatus").textContent = error?.message || String(error);
      });
    });
    $("tagMergeConfirmToggle")?.addEventListener("change", (event) => {
      localStorage.setItem(TAG_MERGE_CONFIRM_KEY, event.target.checked ? "1" : "0");
    });
    const confirmToggle = $("tagMergeConfirmToggle");
    if (confirmToggle) {
      confirmToggle.checked = localStorage.getItem(TAG_MERGE_CONFIRM_KEY) !== "0";
    }
    $("scopeSelect").addEventListener("change", (event) => {
      state.scope = event.target.value;
      state.visibleLimit = INITIAL_NODE_LIMIT;
      state.visibleOffset = 0;
      updateView();
    });
    $("groupSelect").addEventListener("change", (event) => {
      state.group = event.target.value;
      state.visibleLimit = INITIAL_NODE_LIMIT;
      state.visibleOffset = 0;
      buildGraph();
      renderAll();
    });
    $("tagSearch").addEventListener("input", (event) => {
      state.search = event.target.value.trim();
      state.visibleLimit = INITIAL_NODE_LIMIT;
      state.visibleOffset = 0;
      buildGraph();
      renderAll();
    });
    $("showMoreTagsButton").addEventListener("click", () => {
      const total = filteredTagNames().length;
      state.visibleLimit = Math.min(Math.min(MAX_NODE_LIMIT, total), state.visibleLimit + NODE_INCREMENT);
      renderGraph();
      updateShowMoreButton();
    });
    $("refreshTagsButton").addEventListener("click", () => {
      const total = filteredTagNames().length;
      const shown = Math.min(state.visibleLimit, MAX_NODE_LIMIT, total);
      if (total <= shown) return;
      state.visibleOffset = (state.visibleOffset + shown) % total;
      renderGraph();
      updateShowMoreButton();
    });
    $("arrangeGraphButton").addEventListener("click", arrangeGraph);
    $("resetViewButton").addEventListener("click", resetView);
    $("clearSelectionButton").addEventListener("click", () => {
      selectTag("").catch((error) => setMessage(`取消筛选失败：${error?.message || error}`, "warning"));
    });
    $("windowMinimizeButton")?.addEventListener("click", () => callWindowApi("minimize"));
    $("windowMaximizeButton")?.addEventListener("click", toggleWindowMaximize);
    $("windowCloseButton")?.addEventListener("click", () => callWindowApi("hide"));
    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeTagManager();
    });
    window.addEventListener("eagle-library-changed", () => {
      if (Date.now() < state.suppressLibraryRefreshUntil) return;
      loadData(true);
    });
  }

  async function start() {
    await window.pluginReady;
    $("buildInfo").textContent = BUILD_LABEL;
    bindControls();
    await loadData(false);
  }

  start();
})();
