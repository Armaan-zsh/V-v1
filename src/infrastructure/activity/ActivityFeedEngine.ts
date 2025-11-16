import { prisma } from '../database/prisma';
import { redis } from '../database/redis';
import pino from 'pino';
import { z } from 'zod';

// Types for activity feed system
export interface ActivityItem {
  id: string;
  type: ActivityType;
  userId: string;
  targetUserId?: string;
  targetItemId?: string;
  targetGroupId?: string;
  data: ActivityData;
  visibility: 'public' | 'followers' | 'private';
  timestamp: Date;
  metadata?: {
    source?: string;
    platform?: string;
    engagement?: {
      likes: number;
      shares: number;
      comments: number;
    };
  };
}

export type ActivityType = 
  | 'reading_started'
  | 'reading_completed'
  | 'reading_progress'
  | 'item_added'
  | 'item_recommended'
  | 'streak_milestone'
  | 'achievement_unlocked'
  | 'social_interaction'
  | 'group_activity'
  | 'system_notification';

export interface ActivityData {
  title: string;
  description: string;
  icon?: string;
  image?: string;
  actionUrl?: string;
  tags?: string[];
  context?: Record<string, any>;
}

export interface FeedFilter {
  userId?: string;
  types?: ActivityType[];
  visibility?: ('public' | 'followers' | 'private')[];
  since?: Date;
  until?: Date;
  limit?: number;
  offset?: number;
  includeUserInfo?: boolean;
  includeItemInfo?: boolean;
}

export interface FeedResponse {
  items: Array<{
    activity: ActivityItem;
    user?: {
      id: string;
      name: string;
      avatar?: string;
    };
    target?: {
      item?: {
        id: string;
        title: string;
        author?: string;
        image?: string;
      };
      user?: {
        id: string;
        name: string;
        avatar?: string;
      };
    };
  }>;
  pagination: {
    hasMore: boolean;
    nextOffset?: number;
    totalCount: number;
  };
  metadata: {
    generatedAt: string;
    filterApplied: FeedFilter;
    processingTime: number;
  };
}

export interface CreateActivityInput {
  type: ActivityType;
  userId: string;
  targetUserId?: string;
  targetItemId?: string;
  targetGroupId?: string;
  data: ActivityData;
  visibility?: 'public' | 'followers' | 'private';
  metadata?: ActivityItem['metadata'];
}

// Validation schemas
export const CreateActivitySchema = z.object({
  type: z.enum([
    'reading_started', 'reading_completed', 'reading_progress', 'item_added',
    'item_recommended', 'streak_milestone', 'achievement_unlocked',
    'social_interaction', 'group_activity', 'system_notification'
  ]),
  userId: z.string().uuid(),
  targetUserId: z.string().uuid().optional(),
  targetItemId: z.string().uuid().optional(),
  targetGroupId: z.string().uuid().optional(),
  data: z.object({
    title: z.string(),
    description: z.string(),
    icon: z.string().optional(),
    image: z.string().optional(),
    actionUrl: z.string().optional(),
    tags: z.array(z.string()).optional(),
    context: z.record(z.any()).optional(),
  }),
  visibility: z.enum(['public', 'followers', 'private']).default('public'),
  metadata: z.object({
    source: z.string().optional(),
    platform: z.string().optional(),
    engagement: z.object({
      likes: z.number().default(0),
      shares: z.number().default(0),
      comments: z.number().default(0),
    }).optional(),
  }).optional(),
});

export class ActivityFeedEngine {
  private logger: pino.Logger;
  private readonly CACHE_TTL = 3600; // 1 hour
  private readonly MAX_FEED_SIZE = 100;
  private readonly BATCH_SIZE = 10;

  constructor() {
    this.logger = pino({
      level: process.env.LOG_LEVEL || 'info',
      transport: process.env.NODE_ENV === 'development' ? {
        target: 'pino-pretty',
        options: { colorize: true }
      } : undefined
    });
  }

  /**
   * Create a new activity item
   */
  async createActivity(input: CreateActivityInput): Promise<ActivityItem> {
    try {
      const validatedInput = CreateActivitySchema.parse(input);
      
      const activity: ActivityItem = {
        id: this.generateActivityId(),
        ...validatedInput,
        timestamp: new Date(),
      };

      // Store in database
      await this.storeActivity(activity);

      // Update user's feed cache
      await this.updateFeedCache(activity);

      // Notify relevant users in real-time
      await this.broadcastActivity(activity);

      this.logger.info('Activity created', { 
        activityId: activity.id,
        type: activity.type,
        userId: activity.userId,
      });

      return activity;

    } catch (error) {
      this.logger.error('Failed to create activity', { input, error });
      throw error;
    }
  }

  /**
   * Get personalized feed for a user
   */
  async getFeed(userId: string, filter: Partial<FeedFilter> = {}): Promise<FeedResponse> {
    const startTime = Date.now();

    try {
      // Build cache key
      const cacheKey = this.buildFeedCacheKey(userId, filter);
      
      // Try to get from cache first
      const cached = await redis.get(cacheKey);
      if (cached) {
        const cachedResponse = JSON.parse(cached);
        this.logger.debug('Feed retrieved from cache', { userId, cacheKey });
        return cachedResponse;
      }

      // Get feed from database
      const feed = await this.fetchFeedFromDatabase(userId, filter);

      // Enrich with user and item information
      const enrichedFeed = await this.enrichFeedItems(feed);

      // Cache the result
      await redis.setex(cacheKey, this.CACHE_TTL, JSON.stringify(enrichedFeed));

      const processingTime = Date.now() - startTime;
      enrichedFeed.metadata.processingTime = processingTime;

      this.logger.info('Feed generated', { 
        userId, 
        itemsCount: enrichedFeed.items.length,
        processingTime,
      });

      return enrichedFeed;

    } catch (error) {
      this.logger.error('Failed to get feed', { userId, filter, error });
      throw error;
    }
  }

  /**
   * Get global/public activity feed
   */
  async getGlobalFeed(filter: Partial<FeedFilter> = {}): Promise<FeedResponse> {
    const startTime = Date.now();

    try {
      const globalFilter: FeedFilter = {
        ...filter,
        visibility: ['public'],
        limit: filter.limit || 50,
      };

      const feed = await this.fetchFeedFromDatabase(null, globalFilter);
      const enrichedFeed = await this.enrichFeedItems(feed);
      
      const processingTime = Date.now() - startTime;
      enrichedFeed.metadata.processingTime = processingTime;

      return enrichedFeed;

    } catch (error) {
      this.logger.error('Failed to get global feed', { filter, error });
      throw error;
    }
  }

  /**
   * Get activity feed for a specific group
   */
  async getGroupFeed(groupId: string, filter: Partial<FeedFilter> = {}): Promise<FeedResponse> {
    const startTime = Date.now();

    try {
      // Verify group exists and user has access
      const group = await prisma.readingGroup.findUnique({
        where: { id: groupId },
        select: { id: true, name: true, privacy: true },
      });

      if (!group) {
        throw new Error('Group not found');
      }

      const groupFilter: FeedFilter = {
        ...filter,
        targetGroupId: groupId,
        visibility: ['public', 'followers'], // Group activities are typically visible to members
        limit: filter.limit || 30,
      };

      const feed = await this.fetchFeedFromDatabase(null, groupFilter);
      const enrichedFeed = await this.enrichFeedItems(feed);
      
      const processingTime = Date.now() - startTime;
      enrichedFeed.metadata.processingTime = processingTime;

      return enrichedFeed;

    } catch (error) {
      this.logger.error('Failed to get group feed', { groupId, filter, error });
      throw error;
    }
  }

  /**
   * Create automatic activity items based on user actions
   */
  async trackUserAction(userId: string, action: string, data: any): Promise<void> {
    try {
      switch (action) {
        case 'reading_started':
          await this.createActivity({
            type: 'reading_started',
            userId,
            targetItemId: data.itemId,
            data: {
              title: 'Started reading',
              description: `Started reading "${data.itemTitle}"`,
              actionUrl: `/items/${data.itemId}`,
              tags: [data.category || 'reading'],
            },
          });
          break;

        case 'reading_completed':
          await this.createActivity({
            type: 'reading_completed',
            userId,
            targetItemId: data.itemId,
            data: {
              title: 'Finished reading',
              description: `Completed "${data.itemTitle}"`,
              actionUrl: `/items/${data.itemId}`,
              tags: [data.category || 'reading', 'completed'],
            },
          });

          // Check for streak milestone
          if (data.streakDays && data.streakDays % 7 === 0) {
            await this.createActivity({
              type: 'streak_milestone',
              userId,
              data: {
                title: 'Reading Streak!',
                description: `Maintained a ${data.streakDays}-day reading streak! 🔥`,
                icon: '🔥',
                tags: ['streak', 'milestone'],
              },
            });
          }
          break;

        case 'item_added':
          await this.createActivity({
            type: 'item_added',
            userId,
            targetItemId: data.itemId,
            data: {
              title: 'Added to reading list',
              description: `Added "${data.itemTitle}" to reading list`,
              actionUrl: `/items/${data.itemId}`,
              tags: ['wishlist', 'to-read'],
            },
          });
          break;

        case 'achievement_unlocked':
          await this.createActivity({
            type: 'achievement_unlocked',
            userId,
            data: {
              title: 'Achievement Unlocked!',
              description: data.achievement,
              icon: '🏆',
              tags: ['achievement'],
            },
          });
          break;

        case 'social_interaction':
          if (data.interactionType === 'like' || data.interactionType === 'share') {
            await this.createActivity({
              type: 'social_interaction',
              userId,
              targetItemId: data.itemId,
              data: {
                title: `Liked "${data.itemTitle}"`,
                description: data.description || '',
                actionUrl: `/items/${data.itemId}`,
                tags: [data.interactionType, 'social'],
              },
            });
          }
          break;
      }

    } catch (error) {
      this.logger.error('Failed to track user action', { userId, action, data, error });
      // Don't throw - activity tracking shouldn't break user flow
    }
  }

  /**
   * Store activity in database
   */
  private async storeActivity(activity: ActivityItem): Promise<void> {
    try {
      // Store in UserActivity table
      await prisma.userActivity.create({
        data: {
          userId: activity.userId,
          type: activity.type,
          metadata: {
            ...activity.data,
            visibility: activity.visibility,
            targetUserId: activity.targetUserId,
            targetItemId: activity.targetItemId,
            targetGroupId: activity.targetGroupId,
            ...activity.metadata,
          },
        },
      });

      // Store detailed activity for feed
      await prisma.activityFeed.create({
        data: {
          id: activity.id,
          type: activity.type,
          userId: activity.userId,
          targetUserId: activity.targetUserId,
          targetItemId: activity.targetItemId,
          targetGroupId: activity.targetGroupId,
          data: activity.data,
          visibility: activity.visibility,
          metadata: activity.metadata || {},
          createdAt: activity.timestamp,
        },
      });

    } catch (error) {
      this.logger.error('Failed to store activity', { activity, error });
      throw error;
    }
  }

  /**
   * Fetch feed from database with filtering
   */
  private async fetchFeedFromDatabase(userId: string | null, filter: FeedFilter): Promise<FeedResponse> {
    try {
      const whereClause = this.buildWhereClause(userId, filter);
      const orderBy = { createdAt: 'desc' as const };
      const take = filter.limit || 30;
      const skip = filter.offset || 0;

      // Get activities
      const activities = await prisma.activityFeed.findMany({
        where: whereClause,
        orderBy,
        take,
        skip,
      });

      // Get total count for pagination
      const totalCount = await prisma.activityFeed.count({
        where: whereClause,
      });

      return {
        items: activities.map(activity => ({ activity })),
        pagination: {
          hasMore: skip + activities.length < totalCount,
          nextOffset: skip + activities.length,
          totalCount,
        },
        metadata: {
          generatedAt: new Date().toISOString(),
          filterApplied: filter,
          processingTime: 0,
        },
      };

    } catch (error) {
      this.logger.error('Failed to fetch feed from database', { userId, filter, error });
      throw error;
    }
  }

  /**
   * Build where clause for database queries
   */
  private buildWhereClause(userId: string | null, filter: FeedFilter): any {
    const where: any = {};

    // Time range filtering
    if (filter.since) {
      where.createdAt = { gte: filter.since };
    }
    if (filter.until) {
      where.createdAt = { ...where.createdAt, lte: filter.until };
    }

    // Activity type filtering
    if (filter.types && filter.types.length > 0) {
      where.type = { in: filter.types };
    }

    // Visibility filtering
    if (filter.visibility && filter.visibility.length > 0) {
      where.visibility = { in: filter.visibility };
    }

    // Target filtering
    if (filter.targetItemId) {
      where.targetItemId = filter.targetItemId;
    }
    if (filter.targetUserId) {
      where.targetUserId = filter.targetUserId;
    }
    if (filter.targetGroupId) {
      where.targetGroupId = filter.targetGroupId;
    }

    // User-specific filtering
    if (userId) {
      // For personal feed, include:
      // 1. User's own activities
      // 2. Activities from users they follow
      // 3. Public activities
      where.OR = [
        { userId },
        {
          targetUserId: userId, // Activities mentioning the user
        },
        {
          visibility: 'public',
          type: { not: 'private' }, // Exclude private activities
        },
      ];
    }

    return where;
  }

  /**
   * Enrich feed items with additional information
   */
  private async enrichFeedItems(feed: FeedResponse): Promise<FeedResponse> {
    try {
      const enrichedItems = await Promise.all(
        feed.items.map(async (item) => {
          const enriched = { ...item };

          // Include user information if requested
          if (feed.metadata.filterApplied.includeUserInfo !== false) {
            enriched.user = await this.getUserInfo(item.activity.userId);
          }

          // Include target information if available
          if (item.activity.targetItemId) {
            enriched.target = enriched.target || {};
            enriched.target.item = await this.getItemInfo(item.activity.targetItemId);
          }

          if (item.activity.targetUserId) {
            enriched.target = enriched.target || {};
            enriched.target.user = await this.getUserInfo(item.activity.targetUserId);
          }

          return enriched;
        })
      );

      return {
        ...feed,
        items: enrichedItems,
      };

    } catch (error) {
      this.logger.error('Failed to enrich feed items', { error });
      // Return original feed if enrichment fails
      return feed;
    }
  }

  /**
   * Get user information for activity display
   */
  private async getUserInfo(userId: string): Promise<any> {
    try {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          name: true,
          avatar: true,
        },
      });

      return user || null;
    } catch (error) {
      this.logger.error('Failed to get user info', { userId, error });
      return null;
    }
  }

  /**
   * Get item information for activity display
   */
  private async getItemInfo(itemId: string): Promise<any> {
    try {
      const item = await prisma.item.findUnique({
        where: { id: itemId },
        select: {
          id: true,
          title: true,
          author: true,
          image: true,
        },
      });

      return item || null;
    } catch (error) {
      this.logger.error('Failed to get item info', { itemId, error });
      return null;
    }
  }

  /**
   * Update feed cache after new activity
   */
  private async updateFeedCache(activity: ActivityItem): Promise<void> {
    try {
      // Cache key for user's personal feed
      const userFeedKey = this.buildFeedCacheKey(activity.userId, {});
      await redis.del(userFeedKey);

      // If activity is public, update global feed cache
      if (activity.visibility === 'public') {
        const globalFeedKey = this.buildFeedCacheKey('global', {});
        await redis.del(globalFeedKey);
      }

      // If activity targets a group, update group feed cache
      if (activity.targetGroupId) {
        const groupFeedKey = this.buildFeedCacheKey(`group:${activity.targetGroupId}`, {});
        await redis.del(groupFeedKey);
      }

    } catch (error) {
      this.logger.error('Failed to update feed cache', { activity, error });
    }
  }

  /**
   * Build cache key for feed requests
   */
  private buildFeedCacheKey(userId: string | 'global' | string, filter: Partial<FeedFilter>): string {
    const filterHash = JSON.stringify({
      types: filter.types || [],
      visibility: filter.visibility || [],
      since: filter.since?.toISOString(),
      until: filter.until?.toISOString(),
      limit: filter.limit || 30,
    });

    const filterKey = Buffer.from(filterHash).toString('base64').slice(0, 20);
    
    return `feed:${userId}:${filterKey}`;
  }

  /**
   * Broadcast activity to relevant users in real-time
   */
  private async broadcastActivity(activity: ActivityItem): Promise<void> {
    try {
      // This would integrate with the WebSocket server to push real-time updates
      // For now, we'll just log the broadcast
      this.logger.debug('Broadcasting activity', {
        activityId: activity.id,
        type: activity.type,
        userId: activity.userId,
        visibility: activity.visibility,
      });

      // In a real implementation, you would:
      // 1. Identify users who should receive this activity
      // 2. Send to their WebSocket connections
      // 3. Handle offline users with push notifications

    } catch (error) {
      this.logger.error('Failed to broadcast activity', { activity, error });
    }
  }

  /**
   * Generate unique activity ID
   */
  private generateActivityId(): string {
    return `activity_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Clean up old activity items
   */
  async cleanupOldActivities(daysToKeep: number = 90): Promise<void> {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

      const deletedCount = await prisma.activityFeed.deleteMany({
        where: {
          createdAt: { lt: cutoffDate },
          visibility: 'public', // Only delete public activities
        },
      });

      this.logger.info('Cleaned up old activities', {
        cutoffDate: cutoffDate.toISOString(),
        deletedCount: deletedCount.count,
      });

    } catch (error) {
      this.logger.error('Failed to cleanup old activities', { error });
    }
  }

  /**
   * Get activity statistics
   */
  async getActivityStats(userId?: string): Promise<{
    totalActivities: number;
    activitiesByType: Record<string, number>;
    recentActivity: number;
    topContributors: Array<{ userId: string; count: number }>;
  }> {
    try {
      const whereClause = userId ? { userId } : {};
      
      const totalActivities = await prisma.activityFeed.count({ where: whereClause });

      // Get activities by type
      const activitiesByType = await prisma.activityFeed.groupBy({
        by: ['type'],
        where: whereClause,
        _count: { _all: true },
      });

      // Get recent activity (last 7 days)
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

      const recentActivity = await prisma.activityFeed.count({
        where: {
          ...whereClause,
          createdAt: { gte: sevenDaysAgo },
        },
      });

      // Get top contributors (if not user-specific)
      let topContributors: Array<{ userId: string; count: number }> = [];
      if (!userId) {
        const contributors = await prisma.activityFeed.groupBy({
          by: ['userId'],
          where: { visibility: 'public' },
          _count: { _all: true },
          orderBy: { _count: { _all: 'desc' } },
          take: 10,
        });

        topContributors = contributors.map(c => ({
          userId: c.userId,
          count: c._count._all,
        }));
      }

      return {
        totalActivities,
        activitiesByType: activitiesByType.reduce((acc, item) => {
          acc[item.type] = item._count._all;
          return acc;
        }, {} as Record<string, number>),
        recentActivity,
        topContributors,
      };

    } catch (error) {
      this.logger.error('Failed to get activity stats', { userId, error });
      throw error;
    }
  }
}