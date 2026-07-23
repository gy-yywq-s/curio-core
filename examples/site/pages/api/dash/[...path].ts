// The dashboard's API, served at /dash/api/* (see withCurio in next.config.mjs).
import { dashHandler } from "curio-core/next/dash";

export const config = { api: { bodyParser: false, responseLimit: "8mb" }, maxDuration: 60 };
export default dashHandler();
