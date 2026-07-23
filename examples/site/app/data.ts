import { configureReader, getReader } from "curio-core/next/reader";

// Where an entry's page is, and how dates are written. Change freely.
configureReader({ locale: "en-GB", href: (slug) => `/writing/${slug}` });

export { getReader };
