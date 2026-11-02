// The language switch, and the section marked in the right rail. The page
// reads fine without it: the first port's language is shown by default.

function setLang(lang) {
  document.documentElement.dataset.lang = lang;
  document.querySelectorAll("button[data-lang]").forEach(b => {
    b.setAttribute("aria-pressed", String(b.dataset.lang === lang));
  });
  try { localStorage.setItem("causet-lang", lang); } catch (e) {}
}

document.addEventListener("click", e => {
  const button = e.target.closest("button[data-lang]");
  if (!button) return;
  // Keep the clicked example where it is on screen while the code above it changes.
  const before = button.getBoundingClientRect().top;
  setLang(button.dataset.lang);
  window.scrollBy(0, button.getBoundingClientRect().top - before);
});

// The page's languages are its switch's; the head script has already applied
// a saved choice that is one of them.
const langs = [...document.querySelectorAll(".lang button")].map(b => b.dataset.lang);
setLang(langs.includes(document.documentElement.dataset.lang) ? document.documentElement.dataset.lang : langs[0]);

// A page reached by a link opens at its top, or at the section the link
// names. Some hosts keep the previous page's scroll when their frame loads
// another page, sometimes after it has loaded, so this runs again on load
// and a moment later, unless the reader has scrolled by then. Back,
// forward and reload keep the browser's own restore.
const arrival = performance.getEntriesByType("navigation")[0];
if (!arrival || arrival.type === "navigate") {
  let readerMoved = false;
  for (const type of ["wheel", "touchstart", "keydown", "mousedown"]) {
    addEventListener(type, () => { readerMoved = true; }, { once: true, passive: true });
  }
  const openAtStart = () => {
    if (readerMoved) return;
    const id = decodeURIComponent(location.hash.slice(1));
    const target = id && document.getElementById(id);
    if (target) target.scrollIntoView({ behavior: "instant" });
    else window.scrollTo({ top: 0, behavior: "instant" });
  };
  openAtStart();
  addEventListener("load", openAtStart);
  setTimeout(openAtStart, 300);
}

const tocLinks = [...document.querySelectorAll(".toc a")];
const sections = tocLinks.map(a => document.getElementById(a.getAttribute("href").slice(1)));
function markSection() {
  let current = 0;
  sections.forEach((s, i) => { if (s && s.getBoundingClientRect().top < 140) current = i; });
  tocLinks.forEach((a, i) => a.classList.toggle("on", i === current));
}
document.addEventListener("scroll", markSection, { passive: true });
markSection();
