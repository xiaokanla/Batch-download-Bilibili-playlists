(() => {
  "use strict";

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const timers = new WeakMap();

  function restartClass(element, className, duration = 460) {
    if (!element || reduceMotion.matches) return;
    element.classList.remove(className);
    void element.offsetWidth;
    element.classList.add(className);
    const previous = timers.get(element);
    if (previous) window.clearTimeout(previous);
    timers.set(element, window.setTimeout(() => {
      element.classList.remove(className);
      timers.delete(element);
    }, duration));
  }

  function setMetric(id, value) {
    const element = document.getElementById(id);
    if (!element) return;
    const next = String(value);
    if (element.textContent === next) return;
    element.textContent = next;
    restartClass(element, "value-pop", 420);
  }

  function setActivity(progressId, active, buttonId = "") {
    const progress = document.getElementById(progressId);
    const progressTrack = progress?.closest(".progress");
    const surface = progress?.closest(".panel, .card");
    const button = buttonId ? document.getElementById(buttonId) : null;
    progressTrack?.classList.toggle("is-active", Boolean(active));
    surface?.classList.toggle("is-running", Boolean(active));
    button?.classList.toggle("is-busy", Boolean(active));
  }

  function modeSwitch() {
    restartClass(document.querySelector(".workspace"), "mode-transition", 520);
  }

  function openModal(modal) {
    if (!modal) return;
    modal.classList.remove("closing");
    restartClass(modal, "opening", 360);
  }

  function closeModal(modal) {
    if (!modal || reduceMotion.matches) return;
    restartClass(modal, "closing", 220);
  }

  function boot() {
    const root = document.documentElement;
    root.classList.toggle("motion-reduced", reduceMotion.matches);
    if (reduceMotion.matches) {
      root.classList.add("motion-ready");
      return;
    }
    root.classList.add("motion-enabled");
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => root.classList.add("motion-ready"));
    });
  }

  window.BiliMotion = {
    closeModal,
    modeSwitch,
    openModal,
    restartClass,
    setActivity,
    setMetric,
  };

  boot();
})();
