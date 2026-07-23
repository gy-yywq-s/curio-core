import Link from "next/link";
import { getReader } from "../data";

/** Every picture in the entries, newest first, each leading back to its entry. */
export default async function Gallery() {
  const pictures = await (await getReader()).pictures();
  if (pictures.length === 0) return <p className="muted">No pictures yet.</p>;
  return (
    <div className="wall">
      {pictures.map((picture) => (
        <figure key={picture.id}>
          <Link href={`/writing/${picture.slug}`}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={picture.src} alt={picture.full} loading="lazy" />
          </Link>
          <figcaption className="muted">{picture.short || picture.title}</figcaption>
        </figure>
      ))}
    </div>
  );
}
