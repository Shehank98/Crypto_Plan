import { createApp } from "./app.js";
import { env } from "../lib/env.js";

const app = createApp();
const port = env.port();

app.listen(port, () => {
  console.log(`API listening on http://localhost:${port}`);
});
