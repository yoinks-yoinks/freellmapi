import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { getDb } from '../db/index.js';
import { getProvider } from '../providers/index.js';
import { decrypt } from '../lib/crypto.js';
import { OpenAICompatProvider } from '../providers/openai-compat.js';
import type { Platform } from '@freellmapi/shared/types.js';

export const syncRouter = Router();

/**
 * POST /api/sync/:platform
 *
 * Fetches the live model list from a provider's /models endpoint and upserts
 * the results into the local DB. Models no longer returned by the API are
 * disabled (soft-delete). Only OpenAI-compatible providers are supported.
 */
syncRouter.post('/:platform', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const platform = req.params['platform'] as Platform;
    const provider = getProvider(platform);

    if (!provider) {
      res.status(404).json({ error: `Unknown platform: ${platform}` });
      return;
    }
    if (!(provider instanceof OpenAICompatProvider)) {
      res.status(400).json({ error: `Platform '${platform}' does not support model sync` });
      return;
    }

    const db = getDb();
    const keyRow = db.prepare(
      `SELECT encrypted_key, iv, auth_tag
       FROM api_keys
       WHERE platform = ? AND enabled = 1
       ORDER BY id DESC LIMIT 1`,
    ).get(platform) as { encrypted_key: string; iv: string; auth_tag: string } | undefined;

    if (!keyRow) {
      res.status(400).json({ error: `No enabled API key found for platform: ${platform}` });
      return;
    }

    const apiKey = decrypt(keyRow.encrypted_key, keyRow.iv, keyRow.auth_tag);
    const modelIds = await provider.listModels(apiKey);

    if (modelIds.length === 0) {
      res.json({ synced: 0, inserted: 0, updated: 0, disabled: 0 });
      return;
    }

    const upsert = db.prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, enabled)
      VALUES (?, ?, ?, 50, 50, '', 1)
      ON CONFLICT(platform, model_id) DO UPDATE SET enabled = 1
    `);

    let inserted = 0;
    let updated = 0;

    for (const modelId of modelIds) {
      const existing = db.prepare(
        'SELECT id FROM models WHERE platform = ? AND model_id = ?',
      ).get(platform, modelId);

      if (!existing) {
        upsert.run(platform, modelId, modelId);
        inserted++;
      } else {
        db.prepare(
          'UPDATE models SET enabled = 1 WHERE platform = ? AND model_id = ?',
        ).run(platform, modelId);
        updated++;
      }
    }

    // Disable models no longer returned by the provider.
    const placeholders = modelIds.map(() => '?').join(',');
    const disableResult = db.prepare(
      `UPDATE models SET enabled = 0 WHERE platform = ? AND model_id NOT IN (${placeholders})`,
    ).run(platform, ...modelIds) as { changes: number };

    res.json({
      synced: modelIds.length,
      inserted,
      updated,
      disabled: disableResult.changes,
    });
  } catch (err) {
    next(err);
  }
});
