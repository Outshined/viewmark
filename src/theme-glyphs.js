// Woodcut draws a paper halo under ink. Stained glass draws lead under gold, or a glass fill inside lead.
// Gradient ids are unique because several drawings sit on one page.

const WOOD_INK = "#1f1a15";
const WOOD_PAPER = "#fbf6ea";
const WOOD_FILL = "#f4ead2";
const WOOD_HERB = "#3b6519";
const WOOD_RUBY = "#9e2519";
const GLASS_LEAD = "#15100c";
const GLASS_INK = "#050403";
const GLASS_GOLD = "#f0c860";
const GLASS_BAD = "#ff8a80";

const LINE = {
  plus: ["M12 5v14M5 12h14"],
  minus: ["M5 12h14"],
  menu: ["M4 6h16M4 12h16M4 18h16"],
  link: [
    "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71",
    "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71",
  ],
  filter: ["M22 3H2l8 9.46V19l4 2v-6.54L22 3z"],
  check: ["M20 6 9 17l-5-5"],
};

const EYE_OUTLINE = "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z";
const EYE_PUPIL = "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z";
const FILE_BODY = "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z";
const FILE_FOLD = "M14 2v4a2 2 0 0 0 2 2h4";
const FOLDER = "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z";
const COMMENT = "M12 19l-2-3H7a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3h-3l-2 3z";
const SEARCH_RING = "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16";
const SEARCH_HANDLE = "M21 21l-4.3-4.3";
const DELETE_X = "M18 6 6 18M6 6l12 12";
const EXPAND = "M8 5 L18 12 L8 19 Z";
const COLLAPSE = "M5 8 L12 18 L19 8 Z";

let gradientSeq = 0;

function add(svg, create, tag, attrs) {
  const node = create("http://www.w3.org/2000/svg", tag);
  if (!node || typeof node.setAttribute !== "function") return null;
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  if (typeof svg.appendChild === "function") svg.appendChild(node);
  return node;
}

function strokePair(svg, create, paths, under, over, underWidth, overWidth) {
  for (const d of paths) {
    add(svg, create, "path", {
      d,
      fill: "none",
      stroke: under,
      "stroke-width": underWidth,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    });
    add(svg, create, "path", {
      d,
      fill: "none",
      stroke: over,
      "stroke-width": overWidth,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    });
  }
}

function glassFill(svg, create, inner, outer) {
  gradientSeq += 1;
  const id = `vmg${gradientSeq}`;
  const defs = add(svg, create, "defs", {});
  if (!defs || typeof defs.appendChild !== "function") return GLASS_GOLD;
  const grad = create("http://www.w3.org/2000/svg", "radialGradient");
  if (!grad || typeof grad.setAttribute !== "function") return GLASS_GOLD;
  grad.setAttribute("id", id);
  grad.setAttribute("cx", "38%");
  grad.setAttribute("cy", "32%");
  grad.setAttribute("r", "75%");
  const near = create("http://www.w3.org/2000/svg", "stop");
  const far = create("http://www.w3.org/2000/svg", "stop");
  if (!near || !far) return GLASS_GOLD;
  near.setAttribute("offset", "0%");
  near.setAttribute("stop-color", inner);
  far.setAttribute("offset", "100%");
  far.setAttribute("stop-color", outer);
  grad.appendChild(near);
  grad.appendChild(far);
  defs.appendChild(grad);
  return `url(#${id})`;
}

function woodLines(svg, create, paths, ink) {
  strokePair(svg, create, paths, WOOD_PAPER, ink || WOOD_INK, "5", "2.4");
}

function glassLines(svg, create, paths, face) {
  strokePair(svg, create, paths, GLASS_LEAD, face || GLASS_GOLD, "4.4", "2.2");
}

function woodFilled(svg, create, tag, attrs, fill) {
  add(svg, create, tag, {
    ...attrs,
    fill: fill || WOOD_FILL,
    stroke: WOOD_INK,
    "stroke-width": "2",
    "stroke-linejoin": "round",
    "stroke-linecap": "round",
  });
}

function glassFilled(svg, create, tag, attrs, inner, outer) {
  const fill = glassFill(svg, create, inner, outer);
  add(svg, create, tag, {
    ...attrs,
    fill,
    stroke: GLASS_LEAD,
    "stroke-width": "1.6",
    "stroke-linejoin": "round",
    "stroke-linecap": "round",
  });
}

function paintSearch(svg, create, theme) {
  if (theme === "woodcut") {
    woodLines(svg, create, [SEARCH_RING], WOOD_INK);
    woodLines(svg, create, [SEARCH_HANDLE], WOOD_RUBY);
    return true;
  }
  glassFilled(svg, create, "circle", { cx: "11", cy: "11", r: "6.5" }, "#d5dee6", "#3e4c57");
  glassLines(svg, create, [SEARCH_HANDLE], GLASS_GOLD);
  return true;
}

function paintEye(svg, create, theme, off) {
  const paths = [EYE_OUTLINE, EYE_PUPIL];
  if (theme === "woodcut") {
    woodLines(svg, create, paths, WOOD_INK);
    if (off) woodLines(svg, create, ["M3 21 L21 3"], WOOD_RUBY);
    return true;
  }
  glassLines(svg, create, paths, "#d5dee6");
  if (off) glassLines(svg, create, ["M3 21 L21 3"], GLASS_BAD);
  return true;
}

function paintDelete(svg, create, theme) {
  if (theme === "woodcut") {
    woodFilled(svg, create, "circle", { cx: "12", cy: "12", r: "9" }, WOOD_FILL);
    woodLines(svg, create, [DELETE_X], WOOD_INK);
    return true;
  }
  glassFilled(svg, create, "circle", { cx: "12", cy: "12", r: "9" }, "#f2607e", "#980e2e");
  strokePair(svg, create, [DELETE_X], GLASS_LEAD, GLASS_INK, "4.4", "2.2");
  return true;
}

function paintFile(svg, create, theme) {
  if (theme === "woodcut") {
    woodFilled(svg, create, "path", { d: FILE_BODY });
    woodLines(svg, create, [FILE_FOLD]);
    return true;
  }
  glassFilled(svg, create, "path", { d: FILE_BODY }, "#fff6df", "#c4a574");
  glassLines(svg, create, [FILE_FOLD], GLASS_GOLD);
  return true;
}

function paintFolder(svg, create, theme) {
  if (theme === "woodcut") {
    woodFilled(svg, create, "path", { d: FOLDER }, "#e7d3a8");
    return true;
  }
  glassFilled(svg, create, "path", { d: FOLDER }, "#e0b07a", "#6b3e1f");
  return true;
}

function paintCopy(svg, create, theme) {
  const back = { x: "4", y: "4", width: "12", height: "12", rx: "2", ry: "2" };
  const front = { x: "8", y: "8", width: "12", height: "12", rx: "2", ry: "2" };
  if (theme === "woodcut") {
    woodFilled(svg, create, "rect", back);
    woodFilled(svg, create, "rect", front, "#fdf8ec");
    return true;
  }
  glassFilled(svg, create, "rect", back, "#fff6df", "#c4a574");
  glassFilled(svg, create, "rect", front, "#fff6df", "#c4a574");
  return true;
}

function paintComment(svg, create, theme) {
  if (theme === "woodcut") {
    woodFilled(svg, create, "path", { d: COMMENT });
    return true;
  }
  glassFilled(svg, create, "path", { d: COMMENT }, "#fff6df", "#c4a574");
  return true;
}

function paintTriangle(svg, create, theme, d) {
  if (theme === "woodcut") {
    add(svg, create, "path", {
      d,
      fill: WOOD_INK,
      stroke: WOOD_PAPER,
      "stroke-width": "5",
      "stroke-linejoin": "round",
      "stroke-linecap": "round",
    });
    add(svg, create, "path", {
      d,
      fill: WOOD_INK,
      stroke: WOOD_INK,
      "stroke-width": "2.4",
      "stroke-linejoin": "round",
      "stroke-linecap": "round",
    });
    return true;
  }
  glassFilled(svg, create, "path", { d }, "#ffe46a", "#c08a00");
  return true;
}

function paintTheme(theme, action, svg, create) {
  if (LINE[action]) {
    const ink = action === "check" ? WOOD_HERB : WOOD_INK;
    const face = action === "check" ? "#86d97f" : action === "filter" ? "#d5dee6" : GLASS_GOLD;
    if (theme === "woodcut") woodLines(svg, create, LINE[action], ink);
    else glassLines(svg, create, LINE[action], face);
    return true;
  }
  if (action === "search") return paintSearch(svg, create, theme);
  if (action === "eye") return paintEye(svg, create, theme, false);
  if (action === "eye-off") return paintEye(svg, create, theme, true);
  if (action === "delete") return paintDelete(svg, create, theme);
  if (action === "file") return paintFile(svg, create, theme);
  if (action === "folder") return paintFolder(svg, create, theme);
  if (action === "copy") return paintCopy(svg, create, theme);
  if (action === "comment") return paintComment(svg, create, theme);
  if (action === "expand") return paintTriangle(svg, create, theme, EXPAND);
  if (action === "collapse") return paintTriangle(svg, create, theme, COLLAPSE);
  return false;
}

export function themeGlyph(theme, action, create) {
  if (theme !== "woodcut" && theme !== "glass") return null;
  if (typeof create !== "function") return null;
  const svg = create("http://www.w3.org/2000/svg", "svg");
  if (!svg || typeof svg.setAttribute !== "function") return null;
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("data-themed", "1");
  svg.setAttribute("data-theme", theme);
  if (!paintTheme(theme, action, svg, create)) return null;
  return svg;
}
