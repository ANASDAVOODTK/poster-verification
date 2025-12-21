import "dotenv/config"; // Loads .env variables automatically
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import path from "path";
import { fileURLToPath } from "url";
import fastifyStatic from "@fastify/static";
import { analyzePoster } from "./services/ai.service.js";

// In ESM, __dirname is not available, so we define it manually:
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const fastify = Fastify({ logger: true });

fastify.register(multipart);

fastify.register(fastifyStatic, {
  root: path.join(__dirname, "../public"),
  prefix: "/", // Serves index.html at the root URL
});

fastify.post("/api/validate", async (request, reply) => {
  const file = await request.file();
  const buffer = await file.toBuffer();

  // Vision LLM handles both OCR and compliance validation
  const result = await analyzePoster(buffer);

  return reply.send(JSON.parse(result));
});

fastify.listen({ port: process.env.PORT || 3000, host: "0.0.0.0" });
