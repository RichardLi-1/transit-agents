// Sets the page's theme before it first paints, so it never flashes the wrong one:
// the viewer's choice from Settings, or else the system's. src/theme.ts keeps it up
// to date after that. A script of its own, as the page allows no inline scripts.
(function () {
  var choice = null;
  try {
    choice = localStorage.getItem("theme");
  } catch (error) {}
  var dark = choice === "dark" || (choice !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
})();
