import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { AppModule } from "./app.module";
import { loadConfigWithDevDefaults } from "./config";

async function bootstrap() {
  const config = loadConfigWithDevDefaults();
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter({ logger: true, bodyLimit: 1024 * 1024 }));
  app.enableCors({ origin: process.env.CORS_ORIGINS?.split(",") ?? ["http://localhost:3000"], credentials: true });
  await app.listen(config.API_PORT, "0.0.0.0");
}
void bootstrap();
