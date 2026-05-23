import type { FastifyInstance } from "fastify";
import type pino from "pino";
import type { Env } from "../env.js";
import type { CredentialsStore } from "./credentials.js";
import {
  registerCredentialsDownloadRoute,
  registerManifestCallbackRoute,
} from "./manifestCallback.js";
import { registerManifestFormRoute } from "./manifestForm.js";

export interface SetupRouteDeps {
  env: Env;
  log: pino.Logger;
  credentials: CredentialsStore;
}

// Registration order mirrors user journey (form → callback → download); Fastify imposes no order.
export function registerSetupRoutes(app: FastifyInstance, deps: SetupRouteDeps): void {
  registerManifestFormRoute(app, deps);
  registerManifestCallbackRoute(app, deps);
  registerCredentialsDownloadRoute(app, deps);
}
