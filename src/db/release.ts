// Release step for hosted deploys: apply migrations, import the reviewed candidate set,
// and publish the AI-checked claims among it. Every step is idempotent.
import { config } from "../config.js";
import { migrate } from "./migrate.js";
import { seedCandidates } from "./seed-candidates.js";
import { aiPublish } from "./ai-publish.js";

await migrate(config.ownerUrl, {
  publicPassword: process.env.IP_PUBLIC_PASSWORD, editorPassword: process.env.IP_EDITOR_PASSWORD, log: true,
});
await seedCandidates(config.ownerUrl, true);
if (process.env.AI_PUBLISH_REVIEWED_CANDIDATES === "true") await aiPublish(config.ownerUrl, true);
else console.log("AI_PUBLISH_REVIEWED_CANDIDATES is not 'true'; leaving candidates for human review.");
