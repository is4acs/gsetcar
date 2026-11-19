"use client";
import Link from "next/link";
import { useEffect, useState } from "react";

/** Rappelle les contrôles commencés et conservés sur ce téléphone (non encore enregistrés). */
export function LocalDraftsNotice() {
  const [drafts, setDrafts] = useState<{ vehicleId: string; plate: string }[]>([]);
  useEffect(() => {
    const found: { vehicleId: string; plate: string }[] = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)!;
        if (!key.startsWith("gset:brouillon:")) continue;
        const d = JSON.parse(localStorage.getItem(key) ?? "{}");
        found.push({ vehicleId: key.slice("gset:brouillon:".length), plate: d.plate ?? "véhicule" });
      }
    } catch {}
    // eslint-disable-next-line react-hooks/set-state-in-effect -- lecture du stockage local après hydratation
    setDrafts(found);
  }, []);
  if (!drafts.length) return null;
  return (
    <div className="card space-y-2 border-amber-300 bg-amber-50">
      <p className="text-sm font-semibold text-amber-900">Brouillon(s) sur ce téléphone, pas encore enregistré(s)</p>
      {drafts.map((d) => <Link key={d.vehicleId} href={`/controle/${d.vehicleId}`} className="btn-secondary btn-sm w-full">Reprendre le contrôle {d.plate}</Link>)}
    </div>
  );
}
