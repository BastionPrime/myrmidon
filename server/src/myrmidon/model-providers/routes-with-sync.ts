// server/src/myrmidon/model-providers/routes-with-sync.ts
//
// myrmidon(1.6.1 MODEL-PROVIDERS B): model provider API with LiteLLM synchronization.
//
// Extends the basic model provider routes to include synchronization with LiteLLM.
// When models are enabled/disabled, the changes are propagated to LiteLLM.
// When providers are added/removed/rotated, the changes are reflected in LiteLLM.

import { Router, type Request } from "express";
import {
  createModelProviderSchema,
  patchModelProviderSchema,
  setModelProviderModelsSchema,
} from "@paperclipai/shared";
import type { ZodType } from "zod";
import { badRequest } from "../../errors.js";
import { assertBoard, assertCompanyAccess } from "../../routes/authz.js";
import type { ModelProviderActivityEntry, ModelProviderService } from "./service.js";
import type { LitellmSyncService } from "../litellm-sync/service.js";

export interface ModelProviderRoutesWithSyncDeps {
  service: ModelProviderService;
  litellmSyncService: LitellmSyncService;
  /** Writes the mutation into the company activity log. Optional: tests pass none. */
  recordActivity?: (entry: ModelProviderActivityEntry) => Promise<void>;
}

function bodyOf(req: Request): Record<string, unknown> {
  const body = req.body;
  return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
}

export function modelProviderRoutesWithSync(deps: ModelProviderRoutesWithSyncDeps): Router {
  const router = Router();
  const activity = (entry: ModelProviderActivityEntry) =>
    deps.recordActivity ? deps.recordActivity(entry) : Promise.resolve();

  const parse = <T>(schema: ZodType<T>, body: unknown): T => {
    const result = schema.safeParse(body);
    if (!result.success) {
      const issues = result.error?.issues ?? [];
      const first = issues[0];
      const path = first?.path?.length ? `${first.path.join(".")}: ` : "";
      throw badRequest(`${path}${first?.message ?? "invalid request body"}`);
    }
    return result.data;
  };

  router.post("/myrmidon/companies/:companyId/model-providers", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const body = parse(createModelProviderSchema, bodyOf(req));
    const provider = await deps.service.createProvider({
      companyId,
      body,
      activity: (entry) => activity(entry),
    });
    res.status(201).json(provider);
  });

  router.get("/myrmidon/companies/:companyId/model-providers", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json({ providers: await deps.service.listProviders(companyId) });
  });

  router.patch("/myrmidon/companies/:companyId/model-providers/:id", async (req, res) => {
    const companyId = req.params.companyId as string;
    const providerId = req.params.id as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const body = parse(patchModelProviderSchema, bodyOf(req));
    if (body.key !== undefined) {
      const view = await deps.service.rotateProviderKey({
        companyId,
        providerId,
        key: body.key,
        activity: (entry) => activity(entry),
      });
      
      // Handle credential rotation in LiteLLM
      await deps.litellmSyncService.handleProviderCredentialRotation(companyId, providerId);
      
      res.json(view);
      return;
    }
    const view = await deps.service.patchProvider({
      companyId,
      providerId,
      body,
      activity: (entry) => activity(entry),
    });
    res.json(view);
  });

  router.delete("/myrmidon/companies/:companyId/model-providers/:id", async (req, res) => {
    const companyId = req.params.companyId as string;
    const providerId = req.params.id as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    await deps.service.removeProvider({
      companyId,
      providerId,
      activity: (entry) => activity(entry),
    });
    res.status(204).send();
  });

  router.get("/myrmidon/companies/:companyId/model-providers/:id/models", async (req, res) => {
    const companyId = req.params.companyId as string;
    const providerId = req.params.id as string;
    assertCompanyAccess(req, companyId);
    res.json({ models: await deps.service.listModels(companyId, providerId) });
  });

  router.post("/myrmidon/companies/:companyId/model-providers/:id/models", async (req, res) => {
    const companyId = req.params.companyId as string;
    const providerId = req.params.id as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const body = parse(setModelProviderModelsSchema, bodyOf(req));
    
    // Process the model updates through the base service first
    const models = await deps.service.setModels({
      companyId,
      providerId,
      models: body.models,
    });
    
    // For each updated model, trigger the LiteLLM sync
    for (const modelUpdate of body.models) {
      if (modelUpdate.enabled !== undefined) {
        await deps.litellmSyncService.handleModelEnableDisable(
          companyId,
          providerId,
          modelUpdate.modelName,
          modelUpdate.enabled
        );
      }
    }
    
    res.json({ models });
  });

  return router;
}