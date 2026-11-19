import { timingSafeEqual } from "node:crypto";
import { runDriveJobs } from "@/lib/jobs";

export const maxDuration = 60;

// Appelé par la tâche planifiée Vercel (vercel.json) avec « Authorization: Bearer $CRON_SECRET ».
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const given = Buffer.from(req.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (!secret || given.length !== expected.length || !timingSafeEqual(given, expected)) return new Response("Unauthorized", { status: 401 });
  return Response.json(await runDriveJobs({ budgetMs: 45_000 }));
}
