import { resolve } from "node:path";
import { config } from "dotenv";

const configuredPath = process.env.PINGU_ENV_FILE?.trim();

config(configuredPath ? { path: resolve(configuredPath) } : undefined);
