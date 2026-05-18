import { loadEnvFile } from "node:process";
import express from "express";
import cors from "cors";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  startGame,
  submitGuess,
  getStats,
} from "./services/gameController.js";
import { getWordDefinition } from "./services/dictionaryLookup.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
try {
  loadEnvFile(join(__dirname, "..", ".env"));
} catch {
  /* optional local secrets */
}
const publicDir = join(__dirname, "..", "public");
const PORT = Number(process.env.PORT) || 3000;

const app = express();

app.use(
  cors({
    origin: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-Device-Id"],
  }),
);
app.use(express.json({ limit: "32kb" }));

app.post("/api/game/start", startGame);
app.post("/api/game/guess", submitGuess);
app.get("/api/stats", getStats);
app.get("/api/word-definition", getWordDefinition);

app.use(express.static(publicDir));

app.get(/^\/(?!api).*/, (_req, res) => {
  res.sendFile(join(publicDir, "index.html"));
});

app.listen(PORT, () => {
  console.log(`Server http://localhost:${PORT}`);
});
