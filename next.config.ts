import type { NextConfig } from "next";

// Application interne entièrement authentifiée, données toujours fraîches :
// pas de Cache Components (rendu dynamique classique).
const nextConfig: NextConfig = {
  turbopack: {
    rules: {
      "*.css": { loaders: ["@tailwindcss/turbopack"], as: "*.css" },
    },
  },
  experimental: {
    // Devis / factures envoyés par formulaire (limite Vercel : 4,5 Mo par requête).
    serverActions: { bodySizeLimit: "4500kb" },
  },
  serverExternalPackages: ["pg"],
};

export default nextConfig;
