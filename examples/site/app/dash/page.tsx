import { notFound } from "next/navigation";
import { canOpenDash } from "curio-core/next/dash";
import { Dash } from "./dash";

export const metadata = { robots: { index: false, follow: false } };

/** The owner's dashboard: only for whoever passes canAccessDashboard. */
export default async function DashPage() {
  if (!(await canOpenDash())) notFound();
  return <Dash />;
}
