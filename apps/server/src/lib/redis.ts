import { Redis } from "ioredis";
import { env } from "./env";

export function createRedis(): Redis {
  return new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2 });
}
