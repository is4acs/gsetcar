"use client";
import { useEffect, useRef } from "react";

/** Zone de signature au doigt. Renvoie une image PNG (data URL) à chaque fin de tracé, ou null si effacée. */
export function SignaturePad({ value, onChange, label }: { value: string | null; onChange: (v: string | null) => void; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const dirty = useRef(false);

  useEffect(() => {
    const c = ref.current;
    if (!c || value) return;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
    dirty.current = false;
  }, [value]);

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = ref.current!, r = c.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * c.width, y: ((e.clientY - r.top) / r.height) * c.height };
  };
  const start = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    const ctx = ref.current!.getContext("2d")!, p = point(e);
    ctx.lineWidth = 3; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = "#0f172a";
    ctx.beginPath(); ctx.moveTo(p.x, p.y);
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const ctx = ref.current!.getContext("2d")!, p = point(e);
    ctx.lineTo(p.x, p.y); ctx.stroke();
    dirty.current = true;
  };
  const end = () => {
    if (!drawing.current) return;
    drawing.current = false;
    if (dirty.current) onChange(ref.current!.toDataURL("image/png"));
  };

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="label !mb-0">{label}</span>
        {value && <button type="button" className="text-sm text-blue-700 underline" onClick={() => onChange(null)}>Effacer</button>}
      </div>
      {value ? (
        // eslint-disable-next-line @next/next/no-img-element -- signature locale (data URL)
        <img src={value} alt={label} className="h-32 w-full rounded-xl border border-slate-300 bg-white object-contain" />
      ) : (
        <canvas ref={ref} width={600} height={200} aria-label={label} onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={end}
          className="h-32 w-full touch-none rounded-xl border-2 border-dashed border-slate-400 bg-white" />
      )}
      {!value && <p className="muted">Signez avec le doigt dans le cadre.</p>}
    </div>
  );
}
