"use client";

import { useEffect, useRef } from "react";

/*
  An HTML entry's body. Its scripts arrive inert (type "curio/script", see
  EntryBody) so they cannot run before the page is ready, or twice; once
  the body is on the page they are run here, in order, each once.

  Scripts can draw in the site's look through window.curio:
    curio.color(name, alpha?)   the CSS custom property --<name> on :root
                                (a hex colour can take an alpha)
    curio.font(rem, family?)    a canvas font from --sans, --serif or --mono
    curio.scale                 device pixels per CSS pixel
    curio.reducedMotion         whether the reader asked for less motion
*/

type Kit = {
  color: (name: string, alpha?: number) => string;
  font: (rem: number, family?: "sans" | "serif" | "mono", weight?: number) => string;
  scale: number;
  reducedMotion: boolean;
};

function kit(): Kit {
  const style = getComputedStyle(document.documentElement);
  const read = (variable: string) => style.getPropertyValue(variable).trim();
  const rgb = (value: string) => {
    const hex = value.replace("#", "");
    const full = hex.length === 3 ? hex.replace(/./g, (digit) => digit + digit) : hex;
    return [0, 2, 4].map((at) => parseInt(full.slice(at, at + 2), 16));
  };
  return {
    color(name, alpha) {
      const value = read(`--${name}`);
      if (alpha === undefined || !value.startsWith("#")) return value;
      return `rgba(${rgb(value).join(", ")}, ${Math.max(0, Math.min(1, alpha))})`;
    },
    font(rem, family = "sans", weight = 400) {
      const root = parseFloat(style.fontSize) || 16;
      return `${weight} ${rem * root * (window.devicePixelRatio || 1)}px ${read(`--${family}`) || family}`;
    },
    get scale() {
      return window.devicePixelRatio || 1;
    },
    get reducedMotion() {
      return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    },
  };
}

declare global {
  interface Window {
    curio?: Kit;
  }
}

export function HtmlBody({ html, className }: { html: string; className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    window.curio ||= kit();
    let stopped = false;
    const waiting = [...element.querySelectorAll<HTMLScriptElement>('script[type="curio/script"]')];
    (async () => {
      for (const inert of waiting) {
        if (stopped) return;
        const script = document.createElement("script");
        for (const { name, value } of [...inert.attributes]) {
          if (name !== "type" && name !== "data-type") script.setAttribute(name, value);
        }
        const type = inert.getAttribute("data-type");
        if (type) script.type = type;
        script.text = inert.text;
        const loaded = script.src && script.type !== "module"
          ? new Promise((done) => { script.onload = script.onerror = done; })
          : null;
        inert.replaceWith(script);
        if (loaded) await loaded;
      }
    })();
    return () => {
      stopped = true;
    };
  }, [html]);
  return <div ref={box} className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}
