import { createApp } from "./app.js";
import { env } from "../lib/env.js";

// Fail loudly (in logs) if required config is missing, so a missing JWT_SECRET
// surfaces at boot instead of as a confusing 500 on the first auth request.
const missing: string[] = [];
if (!process.env.DATABASE_URL) missing.push("DATABASE_URL");
if (!process.env.JWT_SECRET) missing.push("JWT_SECRET");
if (missing.length > 0) {
  console.error(
    `[startup] Missing required env var(s): ${missing.join(", ")}. ` +
      `Auth and/or database access will fail until these are set.`,
  );
}

const app = createApp();
const port = env.port();

app.listen(port, () => {
  console.log(`API listening on port ${port}`);
});
