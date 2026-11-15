// Woodcut icons follow the woodcut line rule: a paper margin under ink.
// Stained glass icons follow the two-pass lead and the small ui pictures:
// a glass fill, then lead. Widths are the 64-unit pictures scaled into this
// 24-unit box, tightened where a repeated bar would otherwise merge.

const WOOD_INK = "#1f1a15";
const WOOD_PAPER = "#f4ead2";
const WOOD_BRIGHT = "#fdf8ec";
const WOOD_HERB = "#3b6519";
const WOOD_RUBY = "#9e2519";
const GLASS_LEAD = "#15100c";
const GLASS_INK = "#050403";
const GLASS_GOLD = "#ffe46a";
const GLASS_GOLD_EDGE = "#c08a00";

const LINE = {
  plus: ["M12 5v14M5 12h14"],
  minus: ["M5 12h14"],
  link: [
    "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71",
    "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71",
  ],
  check: ["M20 6 9 17l-5-5"],
};

const EYE_OUTLINE = "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z";
const FILE_BODY = "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z";
const FILE_FOLD = "M14 2v4a2 2 0 0 0 2 2h4";
const FOLDER = "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z";
const COMMENT = "M12 19l-2-3H7a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3h-3l-2 3z";
const FILTER = "M22 3H2l8 9.46V19l4 2v-6.54L22 3z";
const DELETE_X = "M7 7 L17 17 M17 7 L7 17";
const EXPAND = "M8 5 L18 12 L8 19 Z";
const COLLAPSE = "M5 8 L12 18 L19 8 Z";
const BARS = [2.6, 10.2, 17.8];

let gradientSeq = 0;

function add(svg, create, tag, attrs) {
  const node = create("http://www.w3.org/2000/svg", tag);
  if (!node || typeof node.setAttribute !== "function") return null;
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  if (typeof svg.appendChild === "function") svg.appendChild(node);
  return node;
}

function glassFill(svg, create, center, edge) {
  gradientSeq += 1;
  const id = `vmg${gradientSeq}`;
  const defs = add(svg, create, "defs", {});
  if (!defs || typeof defs.appendChild !== "function") return center;
  const grad = create("http://www.w3.org/2000/svg", "radialGradient");
  if (!grad || typeof grad.setAttribute !== "function") return center;
  grad.setAttribute("id", id);
  grad.setAttribute("cx", "50%");
  grad.setAttribute("cy", "50%");
  grad.setAttribute("r", "50%");
  const near = create("http://www.w3.org/2000/svg", "stop");
  const far = create("http://www.w3.org/2000/svg", "stop");
  if (!near || !far) return center;
  near.setAttribute("offset", "0");
  near.setAttribute("stop-color", center);
  far.setAttribute("offset", "1");
  far.setAttribute("stop-color", edge);
  grad.appendChild(near);
  grad.appendChild(far);
  defs.appendChild(grad);
  return `url(#${id})`;
}

function woodOpen(svg, create, paths, ink, paperWidth, inkWidth) {
  for (const d of paths) {
    add(svg, create, "path", {
      d,
      fill: "none",
      stroke: WOOD_PAPER,
      "stroke-width": paperWidth,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    });
    add(svg, create, "path", {
      d,
      fill: "none",
      stroke: ink,
      "stroke-width": inkWidth,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    });
  }
}

function glassOpen(svg, create, paths, face, leadWidth, faceWidth) {
  for (const d of paths) {
    add(svg, create, "path", {
      d,
      fill: "none",
      stroke: GLASS_LEAD,
      "stroke-width": leadWidth,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    });
    add(svg, create, "path", {
      d,
      fill: "none",
      stroke: face,
      "stroke-width": faceWidth,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    });
  }
}

function woodInk(svg, create, tag, attrs) {
  add(svg, create, tag, {
    ...attrs,
    fill: WOOD_INK,
    stroke: WOOD_PAPER,
    "stroke-width": "1.8",
    "stroke-linejoin": "round",
    "stroke-linecap": "round",
  });
  add(svg, create, tag, {
    ...attrs,
    fill: WOOD_INK,
    stroke: WOOD_INK,
    "stroke-width": "1.1",
    "stroke-linejoin": "round",
    "stroke-linecap": "round",
  });
}

function woodPlate(svg, create, tag, attrs, fill) {
  const face = fill || WOOD_PAPER;
  add(svg, create, tag, {
    ...attrs,
    fill: face,
    stroke: WOOD_PAPER,
    "stroke-width": "2.4",
    "stroke-linejoin": "round",
    "stroke-linecap": "round",
  });
  add(svg, create, tag, {
    ...attrs,
    fill: face,
    stroke: WOOD_INK,
    "stroke-width": "1.5",
    "stroke-linejoin": "round",
    "stroke-linecap": "round",
  });
}

function glassPiece(svg, create, tag, attrs, center, edge) {
  add(svg, create, tag, {
    ...attrs,
    fill: glassFill(svg, create, center, edge),
    stroke: GLASS_LEAD,
    "stroke-width": "2",
    "stroke-linejoin": "round",
    "stroke-linecap": "round",
  });
}

function woodBars(svg, create) {
  for (const y of BARS) {
    woodInk(svg, create, "rect", { x: "4", y: String(y), width: "16", height: "3.6", rx: "0.4" });
  }
}

function glassBars(svg, create, center, edge) {
  for (const y of BARS) {
    glassPiece(svg, create, "rect", { x: "3.6", y: String(y), width: "16.8", height: "3.8", rx: "1.2" }, center, edge);
  }
}

function paintMenu(svg, create, theme) {
  if (theme === "woodcut") woodBars(svg, create);
  else glassBars(svg, create, GLASS_GOLD, GLASS_GOLD_EDGE);
  return true;
}

function paintLines(svg, create, theme, action) {
  const paths = LINE[action];
  if (theme === "woodcut") {
    const ink = action === "check" ? WOOD_HERB : WOOD_INK;
    const paper = action === "link" ? "3.6" : "5";
    const width = action === "link" ? "2.4" : "3";
    woodOpen(svg, create, paths, ink, paper, width);
    return true;
  }
  const face = action === "check" ? "#9fe27a" : action === "link" ? "#d6e7f7" : GLASS_GOLD;
  const lead = action === "link" ? "3.4" : "4.6";
  const width = action === "link" ? "1.8" : "2.4";
  glassOpen(svg, create, paths, face, lead, width);
  return true;
}

function paintSearch(svg, create, theme) {
  if (theme === "woodcut") {
    woodOpen(svg, create, ["M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14"], WOOD_INK, "3.6", "2.2");
    woodOpen(svg, create, ["M16.2 16.2 L21 21"], WOOD_RUBY, "3.6", "2.2");
    return true;
  }
  glassPiece(svg, create, "circle", { cx: "10.5", cy: "10.5", r: "6.2" }, "#d6e7f7", "#4a78a8");
  glassOpen(svg, create, ["M16.2 16.2 L21 21"], GLASS_GOLD, "4.2", "2.2");
  return true;
}

function paintEye(svg, create, theme, off) {
  if (theme === "woodcut") {
    woodOpen(svg, create, [EYE_OUTLINE], WOOD_INK, "3.2", "1.8");
    woodInk(svg, create, "circle", { cx: "12", cy: "12", r: "2.2" });
    if (off) woodOpen(svg, create, ["M4 19 L20 5"], WOOD_RUBY, "3.4", "2");
    return true;
  }
  glassPiece(svg, create, "path", { d: EYE_OUTLINE }, "#d6e7f7", "#4a78a8");
  glassPiece(svg, create, "circle", { cx: "12", cy: "12", r: "2.4" }, "#f5f8fb", "#7f8a99");
  if (off) glassOpen(svg, create, ["M4 19 L20 5"], "#f2607e", "3.6", "1.8");
  return true;
}

function paintDelete(svg, create, theme) {
  if (theme === "woodcut") {
    woodOpen(svg, create, [DELETE_X], WOOD_INK, "5.2", "3.2");
    return true;
  }
  glassPiece(svg, create, "circle", { cx: "12", cy: "12", r: "8" }, "#f2607e", "#980e2e");
  add(svg, create, "path", {
    d: DELETE_X,
    fill: "none",
    stroke: GLASS_INK,
    "stroke-width": "2.2",
    "stroke-linecap": "round",
  });
  return true;
}

function paintFile(svg, create, theme) {
  if (theme === "woodcut") {
    woodPlate(svg, create, "path", { d: FILE_BODY }, WOOD_BRIGHT);
    woodOpen(svg, create, [FILE_FOLD], WOOD_INK, "2.4", "1.4");
    return true;
  }
  glassPiece(svg, create, "path", { d: FILE_BODY }, "#fcf0c8", "#bf964c");
  glassOpen(svg, create, [FILE_FOLD], GLASS_GOLD, "2.8", "1.4");
  return true;
}

function paintFolder(svg, create, theme) {
  if (theme === "woodcut") {
    woodPlate(svg, create, "path", { d: FOLDER }, "#e7d3a8");
    return true;
  }
  glassPiece(svg, create, "path", { d: FOLDER }, "#dba65a", "#7a4e16");
  return true;
}

function paintCopy(svg, create, theme) {
  const back = { x: "4", y: "4", width: "12", height: "12", rx: "1" };
  const front = { x: "8", y: "8", width: "12", height: "12", rx: "1" };
  if (theme === "woodcut") {
    woodPlate(svg, create, "rect", back, WOOD_PAPER);
    woodPlate(svg, create, "rect", front, WOOD_BRIGHT);
    return true;
  }
  glassPiece(svg, create, "rect", back, "#fcf0c8", "#bf964c");
  glassPiece(svg, create, "rect", front, "#fff6df", "#c4a574");
  return true;
}

function paintComment(svg, create, theme) {
  if (theme === "woodcut") {
    woodPlate(svg, create, "path", { d: COMMENT }, WOOD_BRIGHT);
    return true;
  }
  glassPiece(svg, create, "path", { d: COMMENT }, "#fcf0c8", "#bf964c");
  return true;
}

function paintFilter(svg, create, theme) {
  if (theme === "woodcut") {
    woodPlate(svg, create, "path", { d: FILTER }, WOOD_PAPER);
    return true;
  }
  glassPiece(svg, create, "path", { d: FILTER }, "#d6e7f7", "#4a78a8");
  return true;
}

function paintTriangle(svg, create, theme, d) {
  if (theme === "woodcut") {
    woodInk(svg, create, "path", { d });
    return true;
  }
  glassPiece(svg, create, "path", { d }, GLASS_GOLD, GLASS_GOLD_EDGE);
  return true;
}

function paintTheme(theme, action, svg, create) {
  if (action === "menu") return paintMenu(svg, create, theme);
  if (LINE[action]) return paintLines(svg, create, theme, action);
  if (action === "search") return paintSearch(svg, create, theme);
  if (action === "eye") return paintEye(svg, create, theme, false);
  if (action === "eye-off") return paintEye(svg, create, theme, true);
  if (action === "delete") return paintDelete(svg, create, theme);
  if (action === "file") return paintFile(svg, create, theme);
  if (action === "folder") return paintFolder(svg, create, theme);
  if (action === "copy") return paintCopy(svg, create, theme);
  if (action === "comment") return paintComment(svg, create, theme);
  if (action === "filter") return paintFilter(svg, create, theme);
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
