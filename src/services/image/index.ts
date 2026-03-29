// ============================================================
// Image Generation Service
// Generates artwork/designs via BFL Flux 2 Pro API.
// Uses an adapter pattern so the provider can be swapped later.
// ============================================================

import { createLogger } from '../../utils/logger.js';

import type { AppConfig } from '../../types/index.js';

// ----------------------------------------------------------------
// Public types
// ----------------------------------------------------------------

export interface ImageProvider {
  readonly name: string;
  generateImage(request: ImageRequest): Promise<ImageResult>;
}

export interface ImageRequest {
  readonly prompt: string;
  readonly width?: number;
  readonly height?: number;
  readonly outputFormat?: 'jpeg' | 'png' | 'webp';
  readonly transparentBg?: boolean;
  readonly seed?: number;
}

export interface ImageResult {
  readonly url: string;
  readonly taskId: string;
  readonly format: string;
}

// ----------------------------------------------------------------
// BFL-specific types
// ----------------------------------------------------------------

interface BflSubmitResponse {
  readonly id: string;
  readonly polling_url: string;
}

interface BflPollResponse {
  readonly id: string;
  readonly status: 'Pending' | 'Ready' | 'Error' | 'Request Moderated' | 'Content Moderated' | 'Task not found';
  readonly result?: {
    readonly sample: string;
  };
  readonly progress?: number | null;
}

// ----------------------------------------------------------------
// Error class
// ----------------------------------------------------------------

export class ImageGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageGenerationError';
  }
}

// ----------------------------------------------------------------
// Constants
// ----------------------------------------------------------------

const BFL_BASE_URL = 'https://api.bfl.ai';
const BFL_ENDPOINT = '/v1/flux-2-pro';
const POLL_INTERVAL_MS = 1000;
const MAX_POLL_ATTEMPTS = 120; // 2 minutes max wait

// ----------------------------------------------------------------
// Module-level logger
// ----------------------------------------------------------------

const logger = createLogger('image-service');

// ----------------------------------------------------------------
// BFL Provider
// ----------------------------------------------------------------

function createBflProvider(apiKey: string): ImageProvider {
  async function submitTask(request: ImageRequest): Promise<BflSubmitResponse> {
    const body: Record<string, unknown> = {
      prompt: request.prompt,
    };

    if (request.width !== undefined && request.width > 0) body['width'] = request.width;
    if (request.height !== undefined && request.height > 0) body['height'] = request.height;
    if (request.outputFormat !== undefined) body['output_format'] = request.outputFormat;
    if (request.transparentBg !== undefined) body['transparent_bg'] = request.transparentBg;
    if (request.seed !== undefined) body['seed'] = request.seed;

    const response = await fetch(`${BFL_BASE_URL}${BFL_ENDPOINT}`, {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'x-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => 'no body');
      throw new ImageGenerationError(
        `BFL submit failed (${String(response.status)}): ${text}`,
      );
    }

    const data = await response.json() as BflSubmitResponse;

    if (!data.id || !data.polling_url) {
      throw new ImageGenerationError(
        'BFL submit response missing id or polling_url',
      );
    }

    return data;
  }

  async function pollForResult(pollingUrl: string, taskId: string): Promise<string> {
    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
      await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

      const response = await fetch(pollingUrl, {
        headers: {
          'accept': 'application/json',
          'x-key': apiKey,
        },
      });

      if (!response.ok) {
        const text = await response.text().catch(() => 'no body');
        throw new ImageGenerationError(
          `BFL poll failed (${String(response.status)}): ${text}`,
        );
      }

      const data = await response.json() as BflPollResponse;

      if (data.progress !== undefined && data.progress !== null) {
        logger.debug({ taskId, progress: data.progress }, 'Generation in progress');
      }

      switch (data.status) {
        case 'Ready':
          if (!data.result?.sample) {
            throw new ImageGenerationError('BFL returned Ready but no sample URL');
          }
          return data.result.sample;

        case 'Error':
          throw new ImageGenerationError(`BFL generation failed for task ${taskId}`);

        case 'Request Moderated':
        case 'Content Moderated':
          throw new ImageGenerationError(
            `BFL moderated content for task ${taskId}: ${data.status}`,
          );

        case 'Task not found':
          throw new ImageGenerationError(`BFL task not found: ${taskId}`);

        case 'Pending':
          continue;
      }
    }

    throw new ImageGenerationError(
      `BFL generation timed out after ${String(MAX_POLL_ATTEMPTS)} polls for task ${taskId}`,
    );
  }

  return {
    name: 'bfl-flux-2-pro',

    async generateImage(request: ImageRequest): Promise<ImageResult> {
      logger.info(
        { prompt: request.prompt.slice(0, 80), width: request.width, height: request.height },
        'Submitting image generation to BFL Flux 2 Pro',
      );

      const submitted = await submitTask(request);

      logger.info(
        { taskId: submitted.id },
        'BFL task submitted — polling for result',
      );

      const url = await pollForResult(submitted.polling_url, submitted.id);

      logger.info(
        { taskId: submitted.id },
        'BFL image generation complete',
      );

      return {
        url,
        taskId: submitted.id,
        format: request.outputFormat ?? 'jpeg',
      };
    },
  };
}

// ----------------------------------------------------------------
// Factory
// ----------------------------------------------------------------

/**
 * Creates an image provider from config.
 * Currently only BFL/Flux 2 Pro — adapter pattern makes it easy
 * to swap or add providers later.
 */
export function createImageClient(config: AppConfig['bfl']): ImageProvider {
  logger.info('Initialising BFL Flux 2 Pro image client');
  return createBflProvider(config.apiKey);
}

// ----------------------------------------------------------------
// Convenience: generate product artwork
// ----------------------------------------------------------------

/**
 * Generates artwork for a product design concept.
 * Returns the image URL from BFL. The caller is responsible for
 * downloading and re-hosting — BFL URLs expire after 10 minutes.
 */
export async function generateArtwork(
  client: ImageProvider,
  designConcept: string,
  options?: {
    readonly width?: number;
    readonly height?: number;
    readonly outputFormat?: 'jpeg' | 'png' | 'webp';
    readonly transparentBg?: boolean;
  },
): Promise<ImageResult> {
  logger.info(
    { designConcept: designConcept.slice(0, 80) },
    'Generating product artwork',
  );

  return client.generateImage({
    prompt: designConcept,
    width: options?.width,
    height: options?.height,
    outputFormat: options?.outputFormat ?? 'png',
    transparentBg: options?.transparentBg ?? true,
  });
}
