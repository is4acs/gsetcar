import { apiHandler, appUrl, destroySession } from "@/lib/auth";

export const POST = apiHandler(async (req) => {
  await destroySession();
  return Response.redirect(`${appUrl(req)}/login`, 303);
});
