/*
  The rules an HTML entry keeps (docs/site.md, "HTML"). An HTML entry can
  lay itself out and run scripts, but the site's look is not its to change:
  colours, fonts and type sizes come from the site. A page that breaks a
  rule can be saved as a draft but not published.

  htmlProblems(body) lists what breaks a rule, each with the piece of text
  that does, so the dashboard can show exactly what to change.
*/

const allowedScriptHosts = ["cdn.jsdelivr.net", "unpkg.com", "cdnjs.cloudflare.com", "esm.sh"];
const fontTokens = /^(?:var\(--(?:sans|serif|mono)\)|inherit)$/;
const colourish = /(?:^|-)(?:color|background|border|outline|fill|stroke|caret|accent|column-rule|text-decoration)(?:-|$)/;

const clip = (text) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 60 ? `${line.slice(0, 57)}…` : line;
};

function blocks(body, tag) {
  return [...body.matchAll(new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)</${tag}>`, "gi"))].map((match) => ({
    attributes: match[1],
    text: match[2],
  }));
}

/** Declarations (property, value) and rule selectors in a piece of CSS. */
function readCss(css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/@[a-z-]+[^{;]*\{/gi, "{");
  const selectors = [];
  for (const match of clean.matchAll(/([^{};]+)\{/g)) {
    const selector = match[1].trim();
    if (selector && !/^(?:from|to|[\d.]+%)(?:\s*,|$)/.test(selector)) selectors.push(selector);
  }
  const declarations = [];
  for (const body of clean.matchAll(/\{([^{}]*)\}/g)) {
    for (const part of body[1].split(";")) {
      const colon = part.indexOf(":");
      if (colon < 0) continue;
      declarations.push({ property: part.slice(0, colon).trim().toLowerCase(), value: part.slice(colon + 1).trim() });
    }
  }
  return { selectors, declarations };
}

/** What is left of a colour value once the site's tokens and plain keywords are taken out. */
function leftoverColour(value) {
  return value
    .replace(/var\(--[a-z-]+\)/gi, "")
    .replace(/url\([^)]*\)/gi, "")
    .replace(/\b(?:transparent|currentcolor|inherit|initial|unset|none|solid|dashed|dotted|double|wavy|underline|overline|line-through|hidden|auto|calc|min|max|clamp|no-repeat|repeat|center|top|bottom|left|right|cover|contain|padding-box|border-box|content-box)\b/gi, "")
    .replace(/-?[\d.]+(?:px|rem|em|%|vw|vh|deg|s|ms)?/gi, "")
    .replace(/[\s,()/+*-]/g, "");
}

let customRules;

/**
 * Replaces the rules: a function from a body to its problems
 * ({ rule, text }[]), or null for none (any HTML can be public).
 * Leave it alone to keep the built-in rules.
 */
export function setHtmlRules(rules) {
  customRules = rules;
}

export function htmlProblems(body) {
  if (customRules === null) return [];
  if (typeof customRules === "function") return customRules(String(body || "")) || [];
  const problems = [];
  const add = (rule, text) => problems.push({ rule, text: clip(text) });
  const html = String(body || "");

  const styles = [
    ...blocks(html, "style").map((block) => block.text),
    ...[...html.matchAll(/\sstyle\s*=\s*(["'])([\s\S]*?)\1/gi)].map((match) => `x{${match[2]}}`),
  ];
  for (const css of styles) {
    const { selectors, declarations } = readCss(css);
    for (const selector of selectors) {
      if (selector === "x") continue;
      for (const part of selector.split(",")) {
        if (!/^[.#]/.test(part.trim())) add("A style rule must start with the entry's own class or id.", part);
      }
    }
    for (const { property, value } of declarations) {
      if (property.startsWith("--")) {
        add("The page cannot set its own variables; use the site's.", `${property}: ${value}`);
      } else if (/shadow$/.test(property) && !/^none$/i.test(value)) {
        add("No shadows.", `${property}: ${value}`);
      } else if (/gradient\(/i.test(value)) {
        add("No gradients.", `${property}: ${value}`);
      } else if (property === "font-family" && !fontTokens.test(value)) {
        add("Fonts come from the site: var(--sans), var(--serif) or var(--mono).", `${property}: ${value}`);
      } else if (property === "font" && !/var\(--(?:sans|serif|mono)\)|^inherit$/.test(value)) {
        add("Fonts come from the site: var(--sans), var(--serif) or var(--mono).", `${property}: ${value}`);
      } else if (property === "font-size" && /\d(?:px|pt)\b/i.test(value)) {
        add("Type sizes are in rem or em, not px.", `${property}: ${value}`);
      } else if (colourish.test(property) && leftoverColour(value)) {
        add("Colours come from the site's tokens, e.g. var(--link).", `${property}: ${value}`);
      }
    }
  }

  for (const { attributes, text } of blocks(html, "script")) {
    const source = attributes.match(/\ssrc\s*=\s*(["'])([^"']+)\1/i)?.[2];
    if (source) {
      let host = "";
      try { host = new URL(source).host; } catch { host = ""; }
      if (!allowedScriptHosts.includes(host)) add(`Scripts load only from ${allowedScriptHosts.join(", ")}.`, source);
    }
    for (const match of text.matchAll(/import\s[^'"]*?from\s*(["'])(https?:[^"']+)\1|import\(\s*(["'])(https?:[^"']+)\3/g)) {
      const address = match[2] || match[4];
      let host = "";
      try { host = new URL(address).host; } catch { host = ""; }
      if (!allowedScriptHosts.includes(host)) add(`Scripts load only from ${allowedScriptHosts.join(", ")}.`, address);
    }
    for (const match of text.matchAll(/(["'`])\s*(#[0-9a-f]{3,8}|(?:rgba?|hsla?|oklch|lab)\([^"'`]*\))\s*\1/gi)) {
      add("Colours come from curio.color(…).", match[0]);
    }
    for (const match of text.matchAll(/(?:fillStyle|strokeStyle|shadowColor|\.color|\.background(?:Color)?|\.fill|\.stroke)\s*=\s*(["'`])[^"'`]*\1/g)) {
      add("Colours come from curio.color(…).", match[0]);
    }
    for (const match of text.matchAll(/\.font\s*=(?!\s*curio\.font\()[^;\n]+/g)) {
      add("Canvas text uses curio.font(…).", match[0]);
    }
    for (const match of text.matchAll(/fontFamily|font-family|fontSize\s*=|\.style\.cssText|document\.createElement\(\s*(["'])(?:style|link)\1/g)) {
      add("A script cannot change fonts or add styles.", match[0]);
    }
    for (const match of text.matchAll(/document\.(?:body|documentElement)\.(?:style|classList)|document\.head/g)) {
      add("A script stays inside its own page, not the site's.", match[0]);
    }
  }

  for (const match of html.matchAll(/<(h1|header|footer|nav|iframe|link)\b[^>]*>/gi)) {
    add(
      /iframe|link/i.test(match[1])
        ? "No iframes or outside stylesheets."
        : "No h1, header, footer or navigation: the site has its own.",
      match[0],
    );
  }

  return problems;
}

/** Whether a body is HTML: it begins with a block-level tag (as isHtml in src/model.ts). */
export function isHtmlBody(body) {
  return /^\s*<(article|section|div|figure|header|main|style|p|h[1-6]|table|ul|ol|details|script)\b/i.test(String(body || ""));
}
