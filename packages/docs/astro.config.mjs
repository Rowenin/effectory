import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import starlightLlmsTxt from "starlight-llms-txt";

export default defineConfig({
  integrations: [
    starlight({
      description: "Build and run offline automation with Effect.",
      head: [
        {
          attrs: { href: "/llms.txt", rel: "describedby", type: "text/plain" },
          tag: "link",
        },
      ],
      plugins: [
        starlightLlmsTxt({
          projectName: "Effectory",
          promote: [
            "index",
            "guides/getting-started",
            "guides/first-automation",
          ],
        }),
      ],
      sidebar: [
        { label: "Overview", slug: "index" },
        { label: "Getting started", slug: "guides/getting-started" },
        { label: "Your first automation", slug: "guides/first-automation" },
        { label: "Architecture", slug: "guides/architecture" },
        { label: "Maintain the docs", slug: "guides/documentation" },
      ],
      title: "Effectory Docs",
    }),
  ],
  output: "static",
  site: process.env.DOCS_SITE_URL || "http://127.0.0.1:4321",
});
