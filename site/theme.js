// Shared theme handling for the pages that use styles.css. Loaded synchronously
// in <head> so a stored or system "light" preference applies before first paint,
// then wires every .theme-toggle-btn once the DOM is ready. Same "harness-theme"
// key and system → light → dark cycle as site/index.html and site/haas.html.
(function () {
  var STORE = "harness-theme";
  var DARK_BG = "#0c0e12";
  var LIGHT_BG = "#eef2f7";
  var root = document.documentElement;
  var mq = window.matchMedia("(prefers-color-scheme: light)");

  function current() {
    try { return localStorage.getItem(STORE) || "system"; } catch (e) { return "system"; }
  }
  function save(theme) {
    try { localStorage.setItem(STORE, theme); } catch (e) {}
  }
  function resolve(theme) {
    return theme === "light" ? "light" : theme === "dark" ? "dark" : (mq.matches ? "light" : "dark");
  }
  function apply(theme) {
    var resolved = resolve(theme);
    root.setAttribute("data-theme", resolved);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", resolved === "light" ? LIGHT_BG : DARK_BG);
    var btns = document.querySelectorAll(".theme-toggle-btn");
    for (var i = 0; i < btns.length; i++) {
      btns[i].setAttribute("data-mode", theme);
      btns[i].setAttribute("aria-label", "Switch theme (currently " + theme + ")");
      btns[i].setAttribute("title", "Theme: " + theme);
    }
  }

  apply(current());

  document.addEventListener("DOMContentLoaded", function () {
    var btns = document.querySelectorAll(".theme-toggle-btn");
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener("click", function () {
        var order = ["system", "light", "dark"];
        var next = order[(order.indexOf(current()) + 1) % order.length];
        save(next);
        apply(next);
      });
    }
    apply(current());
  });
  if (typeof mq.addEventListener === "function") {
    mq.addEventListener("change", function () { apply(current()); });
  }
})();
