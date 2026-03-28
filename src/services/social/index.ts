// ============================================================
// Social Scheduling Service
// Schedules and publishes ContentPosts to TikTok and Instagram.
//
// Architecture: Platform-agnostic routing layer + swappable
// platform adapters. When a scheduling tool is selected (Botika,
// Later, Buffer, etc.), implement the SocialPlatformAdapter
// interface and swap it in via createTikTokAdapter /
// createInstagramAdapter. Nothing above the adapter layer changes.
// ============================================================

import { createLogger } from '../../utils/logger.js';
import { ContentError } from '../../utils/errors.js';

import type { ContentPost, ContentPlatform, ContentStatus } from '../../types/index.js';

// ----------------------------------------------------------------
// Logger
// ----------------------------------------------------------------

const logger = createLogger('social-service');

// ----------------------------------------------------------------
// Adapter interface — the swap point
// ----------------------------------------------------------------

/**
 * Platform-agnostic contract every scheduling tool adapter must satisfy.
 *
 * To integrate a new tool (Botika, Later, Buffer, etc.):
 *   1. Implement this interface for that tool's API.
 *   2. Swap the stub in createTikTokAdapter or createInstagramAdapter.
 *   3. Nothing in the routing layer (schedulePost, publishPost, etc.) changes.
 */
export interface SocialPlatformAdapter {
  /**
   * Schedule a post for future publication.
   * Returns the platform-assigned post ID.
   */
  schedulePost(params: SchedulePostParams): Promise<string>;

  /**
   * Immediately publish a post.
   */
  publishPost(postId: string): Promise<void>;

  /**
   * Fetch the current status of a previously scheduled or published post.
   */
  getPostStatus(postId: string): Promise<ContentStatus>;

  /**
   * Cancel a scheduled post before it goes live.
   */
  cancelPost(postId: string): Promise<void>;
}

// ----------------------------------------------------------------
// Shared parameter type
// ----------------------------------------------------------------

export interface SchedulePostParams {
  readonly caption: string;
  readonly mediaUrls: readonly string[];
  readonly scheduledAt: Date;
}

// ----------------------------------------------------------------
// Client type returned by createSocialClient
// ----------------------------------------------------------------

export interface SocialClient {
  readonly tiktok: SocialPlatformAdapter;
  readonly instagram: SocialPlatformAdapter;
}

// ----------------------------------------------------------------
// Stub adapters
// These log and throw until a real tool is wired in.
// ----------------------------------------------------------------

/**
 * Creates the TikTok platform adapter.
 *
 * STUB: Throws ContentError with instructions until a scheduling
 * tool (Botika, Later, Buffer, etc.) is selected and this factory
 * is replaced with a real implementation.
 *
 * @param accessToken - TikTok API access token (unused until implemented)
 */
export function createTikTokAdapter(_accessToken: string): SocialPlatformAdapter {
  return {
    schedulePost(_params: SchedulePostParams): Promise<string> {
      logger.info('TikTok schedulePost called — adapter not configured');
      throw new ContentError(
        'TikTok adapter not configured — select a scheduling tool',
      );
    },

    publishPost(_postId: string): Promise<void> {
      logger.info('TikTok publishPost called — adapter not configured');
      throw new ContentError(
        'TikTok adapter not configured — select a scheduling tool',
      );
    },

    getPostStatus(_postId: string): Promise<ContentStatus> {
      logger.info('TikTok getPostStatus called — adapter not configured');
      throw new ContentError(
        'TikTok adapter not configured — select a scheduling tool',
      );
    },

    cancelPost(_postId: string): Promise<void> {
      logger.info('TikTok cancelPost called — adapter not configured');
      throw new ContentError(
        'TikTok adapter not configured — select a scheduling tool',
      );
    },
  };
}

/**
 * Creates the Instagram platform adapter.
 *
 * STUB: Throws ContentError with instructions until a scheduling
 * tool (Botika, Later, Buffer, etc.) is selected and this factory
 * is replaced with a real implementation.
 *
 * @param accessToken - Instagram API access token (unused until implemented)
 */
export function createInstagramAdapter(_accessToken: string): SocialPlatformAdapter {
  return {
    schedulePost(_params: SchedulePostParams): Promise<string> {
      logger.info('Instagram schedulePost called — adapter not configured');
      throw new ContentError(
        'Instagram adapter not configured — select a scheduling tool',
      );
    },

    publishPost(_postId: string): Promise<void> {
      logger.info('Instagram publishPost called — adapter not configured');
      throw new ContentError(
        'Instagram adapter not configured — select a scheduling tool',
      );
    },

    getPostStatus(_postId: string): Promise<ContentStatus> {
      logger.info('Instagram getPostStatus called — adapter not configured');
      throw new ContentError(
        'Instagram adapter not configured — select a scheduling tool',
      );
    },

    cancelPost(_postId: string): Promise<void> {
      logger.info('Instagram cancelPost called — adapter not configured');
      throw new ContentError(
        'Instagram adapter not configured — select a scheduling tool',
      );
    },
  };
}

// ----------------------------------------------------------------
// Client factory
// ----------------------------------------------------------------

/**
 * Initialises and returns a SocialClient with both platform adapters.
 * Pass the returned client to every routing function below.
 */
export function createSocialClient(config: {
  readonly tiktokAccessToken: string;
  readonly instagramAccessToken: string;
}): SocialClient {
  logger.info('Initialising social client');
  return {
    tiktok: createTikTokAdapter(config.tiktokAccessToken),
    instagram: createInstagramAdapter(config.instagramAccessToken),
  };
}

// ----------------------------------------------------------------
// Internal helpers
// ----------------------------------------------------------------

/**
 * Returns the correct adapter for a given platform.
 * Exhaustive — TypeScript will error if a new ContentPlatform value
 * is added without a corresponding case here.
 */
function adapterFor(client: SocialClient, platform: ContentPlatform): SocialPlatformAdapter {
  switch (platform) {
    case 'tiktok':
      return client.tiktok;
    case 'instagram':
      return client.instagram;
  }
}

/**
 * Asserts that a ContentPost carries a platform post ID in its id field.
 * The post ID returned by the adapter is stored in ContentPost.id after
 * scheduling — this guard surfaces misuse early.
 *
 * Note: ContentPost.id is the internal application ID. The platform-
 * assigned post ID is tracked separately via the return value of
 * schedulePost / publishPost and must be persisted by the caller.
 * This helper validates that scheduledAt is non-null and in the past
 * or future as required by the operation.
 */
function assertScheduledAtInFuture(scheduledAt: Date | null, context: string): Date {
  if (scheduledAt === null) {
    throw new ContentError(`${context}: scheduledAt must be set on the post`);
  }
  if (scheduledAt.getTime() <= Date.now()) {
    throw new ContentError(
      `${context}: scheduledAt must be in the future (got ${scheduledAt.toISOString()})`,
    );
  }
  return scheduledAt;
}

// ----------------------------------------------------------------
// Routing functions
// ----------------------------------------------------------------

/**
 * Schedules a ContentPost for future publication on the correct platform.
 *
 * Validates:
 *   - post.scheduledAt is non-null and in the future
 *   - post.mediaUrls is non-empty
 *
 * Returns a copy of the post with status 'scheduled' and scheduledAt preserved.
 * The platform post ID is returned as the second element of the tuple so the
 * caller can persist it for later status checks or cancellation.
 */
export async function schedulePost(
  client: SocialClient,
  post: ContentPost,
): Promise<{ post: ContentPost; platformPostId: string }> {
  const ctx = `schedulePost(${post.id}, ${post.platform})`;

  const scheduledAt = assertScheduledAtInFuture(post.scheduledAt, ctx);

  if (post.mediaUrls.length === 0) {
    throw new ContentError(`${ctx}: mediaUrls must not be empty`);
  }

  logger.info(
    { postId: post.id, platform: post.platform, scheduledAt },
    'Scheduling post',
  );

  const adapter = adapterFor(client, post.platform);

  const platformPostId = await adapter.schedulePost({
    caption: post.caption,
    mediaUrls: post.mediaUrls,
    scheduledAt,
  });

  const updated: ContentPost = {
    ...post,
    status: 'scheduled',
    scheduledAt,
  };

  logger.info(
    { postId: post.id, platform: post.platform, platformPostId },
    'Post scheduled',
  );

  return { post: updated, platformPostId };
}

/**
 * Immediately publishes a ContentPost on the correct platform.
 *
 * The platformPostId must be the ID previously returned by schedulePost
 * or a platform-native draft ID — it is the caller's responsibility to
 * pass the correct value.
 *
 * Returns a copy of the post with status 'published' and publishedAt set.
 */
export async function publishPost(
  client: SocialClient,
  post: ContentPost,
  platformPostId: string,
): Promise<ContentPost> {
  const ctx = `publishPost(${post.id}, ${post.platform})`;

  if (post.mediaUrls.length === 0) {
    throw new ContentError(`${ctx}: mediaUrls must not be empty`);
  }

  logger.info(
    { postId: post.id, platform: post.platform, platformPostId },
    'Publishing post',
  );

  const adapter = adapterFor(client, post.platform);

  await adapter.publishPost(platformPostId);

  const updated: ContentPost = {
    ...post,
    status: 'published',
    publishedAt: new Date(),
  };

  logger.info(
    { postId: post.id, platform: post.platform },
    'Post published',
  );

  return updated;
}

/**
 * Fetches the current status of a post from the platform and returns
 * an updated ContentPost reflecting that status.
 *
 * The platformPostId must be the ID previously returned by schedulePost.
 */
export async function getPostStatus(
  client: SocialClient,
  post: ContentPost,
  platformPostId: string,
): Promise<ContentPost> {
  logger.info(
    { postId: post.id, platform: post.platform, platformPostId },
    'Fetching post status',
  );

  const adapter = adapterFor(client, post.platform);

  const status = await adapter.getPostStatus(platformPostId);

  const updated: ContentPost = {
    ...post,
    status,
    publishedAt: status === 'published' ? (post.publishedAt ?? new Date()) : post.publishedAt,
  };

  logger.info(
    { postId: post.id, platform: post.platform, status },
    'Post status fetched',
  );

  return updated;
}

/**
 * Cancels a scheduled post and returns the post with status reset to 'draft'.
 *
 * The platformPostId must be the ID previously returned by schedulePost.
 * Only valid for posts currently in 'scheduled' status.
 */
export async function cancelScheduledPost(
  client: SocialClient,
  post: ContentPost,
  platformPostId: string,
): Promise<ContentPost> {
  const ctx = `cancelScheduledPost(${post.id}, ${post.platform})`;

  if (post.status !== 'scheduled') {
    throw new ContentError(
      `${ctx}: can only cancel posts with status 'scheduled' (current: '${post.status}')`,
    );
  }

  logger.info(
    { postId: post.id, platform: post.platform, platformPostId },
    'Cancelling scheduled post',
  );

  const adapter = adapterFor(client, post.platform);

  await adapter.cancelPost(platformPostId);

  const updated: ContentPost = {
    ...post,
    status: 'draft',
    scheduledAt: null,
  };

  logger.info(
    { postId: post.id, platform: post.platform },
    'Scheduled post cancelled',
  );

  return updated;
}

// ----------------------------------------------------------------
// Batch scheduling
// ----------------------------------------------------------------

export interface ScheduleBatchResult {
  readonly postId: string;
  readonly platform: ContentPlatform;
  readonly outcome: 'scheduled';
  readonly post: ContentPost;
  readonly platformPostId: string;
}

export interface ScheduleBatchFailure {
  readonly postId: string;
  readonly platform: ContentPlatform;
  readonly outcome: 'failed';
  readonly error: string;
}

export type ScheduleBatchEntry = ScheduleBatchResult | ScheduleBatchFailure;

/**
 * Schedules multiple ContentPosts sequentially.
 *
 * Sequential (not parallel) to respect third-party API rate limits.
 * Per-post failures are caught, logged, and recorded as ScheduleBatchFailure
 * entries — a single bad post does not abort the batch.
 *
 * Returns an array of ScheduleBatchEntry values. The caller can detect
 * failures by filtering for entries where outcome === 'failed'.
 */
export async function scheduleBatch(
  client: SocialClient,
  posts: readonly ContentPost[],
): Promise<readonly ScheduleBatchEntry[]> {
  logger.info({ count: posts.length }, 'Starting batch schedule');

  const results: ScheduleBatchEntry[] = [];

  for (const post of posts) {
    try {
      const { post: updated, platformPostId } = await schedulePost(client, post);
      results.push({
        postId: post.id,
        platform: post.platform,
        outcome: 'scheduled',
        post: updated,
        platformPostId,
      });
    } catch (cause) {
      const error =
        cause instanceof Error ? cause.message : 'Unknown error during scheduling';

      logger.error(
        { postId: post.id, platform: post.platform, cause },
        'Skipping post in batch — scheduling failed',
      );

      results.push({
        postId: post.id,
        platform: post.platform,
        outcome: 'failed',
        error,
      });
    }
  }

  const scheduled = results.filter((r) => r.outcome === 'scheduled').length;
  const failed = results.filter((r) => r.outcome === 'failed').length;

  logger.info(
    { requested: posts.length, scheduled, failed },
    'Batch schedule complete',
  );

  return results;
}
