import Markdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { isHtml, isVideo } from "../model";
import { resolveAsset, type Entry } from "../read";
import { HtmlBody } from "./html-body";

/**
 * An entry's body: Markdown (GitHub-flavoured, with $maths$) or HTML, with
 * files beside the entry resolved to their addresses. It sets no style:
 * only these class names, for your CSS:
 *
 *   .entry-body                 the body (also .entry-body--html)
 *   .entry-picture              a picture or video in the text, with
 *   .entry-picture-caption      its full description under it
 *   .entry-video                (on .entry-picture) when it is a video
 *
 * External links open in a new tab. HTML bodies run their scripts once the
 * page is ready (see HtmlBody).
 */
export function EntryBody({ entry, className = "entry-body" }: { entry: Pick<Entry, "body" | "assetBase">; className?: string }) {
  if (isHtml(entry.body)) {
    const html = entry.body.replace(
      /\b(src|href|poster)=(["'])([^"']+)\2/g,
      (_, name: string, quote: string, value: string) => `${name}=${quote}${resolveAsset(entry, value)}${quote}`,
    );
    // Scripts are kept inert in the markup and run by HtmlBody once the page is ready.
    const inert = html.replace(/<script\b([^>]*)>/gi, (_, attributes: string) => {
      const type = /\stype\s*=\s*(["'])([^"']*)\1/i.exec(attributes)?.[2] || "";
      const rest = attributes.replace(/\stype\s*=\s*(["'])[^"']*\1/i, "");
      return `<script type="curio/script"${type ? ` data-type="${type}"` : ""}${rest}>`;
    });
    return <HtmlBody html={inert} className={`${className} ${className}--html`} />;
  }

  const local = (value?: string) => resolveAsset(entry, value);
  const external = (value?: string) => /^(?:https?:)?\/\//i.test(value || "");

  return (
    <div className={className}>
      <Markdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { strict: false, throwOnError: false }]]}
        components={{
          img: ({ src, alt, title, ...props }) =>
            typeof src === "string" && isVideo(src) ? (
              <span className="entry-picture entry-video">
                <video src={local(src)} controls playsInline preload="metadata" aria-label={alt || undefined} />
                {alt && <span className="entry-picture-caption">{alt}</span>}
              </span>
            ) : (
              <span className="entry-picture">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img {...props} src={typeof src === "string" ? local(src) : src} alt={alt || ""} title={title} />
                {alt && <span className="entry-picture-caption">{alt}</span>}
              </span>
            ),
          a: ({ href, children, target, rel, ...props }) => {
            const resolved = local(href);
            const opens = external(resolved);
            return (
              <a {...props} href={resolved} target={opens ? "_blank" : target} rel={opens ? "noopener noreferrer" : rel}>
                {children}
              </a>
            );
          },
        }}
      >
        {entry.body}
      </Markdown>
    </div>
  );
}
