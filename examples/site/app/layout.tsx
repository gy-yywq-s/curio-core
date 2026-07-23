import Link from "next/link";
import "katex/dist/katex.min.css";
import "./style.css";
import { folderHref } from "curio-core";
import { keyHolder } from "curio-core/next/reader";
import { getReader } from "./data";
import { hide } from "./key/actions";

export const dynamic = "force-dynamic";

/** The frame of every page: the name, the tabs (folders chosen in the dashboard), and the foot. */
export default async function Layout({ children }: { children: React.ReactNode }) {
  const reader = await getReader();
  const [tabs, site, holding] = await Promise.all([reader.tabs(), reader.site(), keyHolder()]);
  const contact = site.contactLine.split("{email}");
  return (
    <html lang="en">
      <body>
        <header>
          <p><Link href="/">a curio site</Link></p>
          <nav>
            <Link href="/">home</Link>
            {tabs.map((tab) => <Link key={tab.key} href={folderHref(tab.path)}>{tab.name}</Link>)}
            <Link href="/everything">everything</Link>
            <Link href="/gallery">pictures</Link>
            <Link href="/about">about</Link>
          </nav>
        </header>
        <main>{children}</main>
        <footer className="muted">
          {site.contactLine && (
            <p>{contact.map((part, at) => <span key={at}>{at > 0 && <a href={`mailto:${site.contactEmail}`}>{site.contactEmail}</a>}{part}</span>)}</p>
          )}
          {holding && <form action={hide}>private entries shown · <button type="submit">hide</button></form>}
        </footer>
      </body>
    </html>
  );
}
