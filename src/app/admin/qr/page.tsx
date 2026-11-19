import QRCode from "qrcode";
import { headers } from "next/headers";
import { requirePermission } from "@/lib/auth";
import { q } from "@/lib/db";

// Planche de QR codes à imprimer. Chaque code ouvre /v/<plaque> : la connexion reste obligatoire.
export default async function QrSheet() {
  await requirePermission("admin.manage");
  const h = await headers();
  const base = process.env.APP_URL?.replace(/\/$/, "") ?? `${h.get("x-forwarded-proto") ?? "http"}://${h.get("x-forwarded-host") ?? h.get("host")}`;
  const vehicles = await q<{ plate: string; label: string }>("select plate, label from vehicles where status = 'actif' order by plate");
  const codes = await Promise.all(vehicles.map(async (v) => ({ ...v, svg: await QRCode.toString(`${base}/v/${encodeURIComponent(v.plate)}`, { type: "svg", margin: 1, width: 180 }) })));
  return (
    <main className="mx-auto max-w-4xl bg-white p-6">
      <p className="muted mb-4 print:hidden">Imprimez cette page (Ctrl+P). Adresse encodée : {base}/v/&lt;plaque&gt;</p>
      <div className="grid grid-cols-2 gap-6 sm:grid-cols-3">
        {codes.map((c) => (
          <div key={c.plate} className="break-inside-avoid rounded-xl border border-slate-300 p-3 text-center">
            <div dangerouslySetInnerHTML={{ __html: c.svg }} className="mx-auto w-44" />
            <div className="font-mono text-xl font-bold">{c.plate}</div>
            <div className="text-sm text-slate-600">{c.label}</div>
            <div className="text-xs text-slate-500">Contrôle véhicule — GSET</div>
          </div>
        ))}
      </div>
    </main>
  );
}
