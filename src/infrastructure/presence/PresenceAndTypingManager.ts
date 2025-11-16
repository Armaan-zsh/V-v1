import { prisma } from '../database/prisma';
import { redis } from '../database/redis';
import pino from 'pino';
import { z } from 'zod';

// Types for presence and typing indicators
export interface UserPresence {
  userId: string;
  status: 'online' | 'away' | 'busy' | 'offline';
  lastSeen: Date;
  currentActivity?: {
    type: 'reading' | 'searching' | 'browsing' | 'discussing' | 'idle';
    data?: {
      itemId?: string;
      bookTitle?: string;
      searchQuery?: string;
      discussionId?: string;
      groupId?: string;
    };
  };
  device?: {
    type: 'desktop' | 'mobile' | 'tablet';
    browser?: string;
    platform?: string;
  };
  location?: {
    page: string;
    section?: string;
    timestamp: Date;
  };
}

export interface TypingIndicator {
  userId: string;
  roomId: string;
  roomType: 'private' | 'group' | 'discussion' | 'search';
  isTyping: boolean;
  startedAt: Date;
  lastActivity: Date;
}

export interface PresenceEvent {
  type: 'status_change' | 'activity_change' | 'page_change' | 'heartbeat' | 'logout';
  userId: string;
  data: any;
  timestamp: Date;
}

export interface UpdatePresenceInput {
  userId: string;
  status?: 'online' | 'away' | 'busy' | 'offline';
  activity?: UserPresence['currentActivity'];
  device?: UserPresence['device'];
  location?: UserPresence['location'];
}

export interface BulkPresenceUpdateInput {
  userIds: string[];
  updates: Partial<Omit<UserPresence, 'userId' | 'lastSeen'>>;
}

export interface PresenceFilter {
  userIds?: string[];
  status?: ('online' | 'away' | 'busy' | 'offline')[];
  activity?: string[];
  since?: Date;
  limit?: number;
}

export interface PresenceResponse {
  users: Array<{
    presence: UserPresence;
    user?: {
      id: string;
      name: string;
      avatar?: string;
    };
  }>;
  metadata: {
    totalUsers: number;
    onlineCount: number;
    lastUpdate: string;
    filterApplied: PresenceFilter;
  };
}

// Validation schemas
export const UpdatePresenceSchema = z.object({
  userId: z.string().uuid(),
  status: z.enum(['online', 'away', 'busy', 'offline']).optional(),
  activity: z.object({
    type: z.enum(['reading', 'searching', 'browsing', 'discussing', 'idle']),
    data: z.object({
      itemId: z.string().uuid().optional(),
      bookTitle: z.string().optional(),
      searchQuery: z.string().optional(),
      discussionId: z.string().optional(),
      groupId: z.string().optional(),
    }).optional(),
  }).optional(),
  device: z.object({
    type: z.enum(['desktop', 'mobile', 'tablet']),
    browser: z.string().optional(),
    platform: z.string().optional(),
  }).optional(),
  location: z.object({
    page: z.string(),
    section: z.string().optional(),
    timestamp: z.date(),
  }).optional(),
});

export class PresenceAndTypingManager {
  private logger: pino.Logger;
  private presenceCache: Map<string, UserPresence> = new Map();
  private typingIndicators: Map<string, TypingIndicator> = new Map();
  private readonly PRESENCE_TTL = 300; // 5 minutes for heartbeat
  private readonly TYPING_TTL = 10; // 10 seconds for typing indicators
  private readonly BULK_UPDATE_SIZE = 100;

  constructor() {
    this.logger = pino({
      level: process.env.LOG_LEVEL || 'info',
      transport: process.env.NODE_ENV === 'development' ? {
        target: 'pino-pretty',
        options: { colorize: true }
      } : undefined
    });

    // Clean up expired presence and typing indicators periodically
    setInterval(() => {
      this.cleanupExpiredData();
    }, 60000); // Every minute
  }

  /**
   * Update user presence status
   */
  async updatePresence(input: UpdatePresenceInput): Promise<void> {
    try {
      const validatedInput = UpdatePresenceSchema.parse(input);
      const now = new Date();

      // Get existing presence or create new
      let presence = this.presenceCache.get(validatedInput.userId) || {
        userId: validatedInput.userId,
        status: 'offline',
        lastSeen: now,
      };

      // Update presence fields
      if (validatedInput.status) {
        presence.status = validatedInput.status;
      }

      if (validatedInput.activity) {
        presence.currentActivity = validatedInput.activity;
      }

      if (validatedInput.device) {
        presence.device = validatedInput.device;
      }

      if (validatedInput.location) {
        presence.location = validatedInput.location;
      }

      // Update last seen
      presence.lastSeen = now;

      // Update cache
      this.presenceCache.set(validatedInput.userId, presence);

      // Cache in Redis for persistence
      await this.cachePresence(presence);

      // Broadcast presence change to relevant users
      await this.broadcastPresenceUpdate(presence);

      this.logger.debug('Presence updated', {
        userId: validatedInput.userId,
        status: presence.status,
        activity: presence.currentActivity?.type,
      });

    } catch (error) {
      this.logger.error('Failed to update presence', { input, error });
      throw error;
    }
  }

  /**
   * Get presence status for users
   */
  async getPresence(filter: PresenceFilter = {}): Promise<PresenceResponse> {
    try {
      const { userIds, status, activity, since, limit = 50 } = filter;
      let users = Array.from(this.presenceCache.values());

      // Apply filters
      if (userIds && userIds.length > 0) {
        users = users.filter(u => userIds.includes(u.userId));
      }

      if (status && status.length > 0) {
        users = users.filter(u => status.includes(u.status));
      }

      if (activity && activity.length > 0) {
        users = users.filter(u => 
          u.currentActivity && activity.includes(u.currentActivity.type)
        );
      }

      if (since) {
        users = users.filter(u => u.lastSeen >= since);
      }

      // Limit results
      users = users.slice(0, limit);

      // Enrich with user information
      const enrichedUsers = await Promise.all(
        users.map(async (presence) => {
          const user = await this.getUserInfo(presence.userId);
          return {
            presence,
            user,
          };
        })
      );

      const onlineCount = users.filter(u => u.status === 'online').length;

      return {
        users: enrichedUsers,
        metadata: {
          totalUsers: enrichedUsers.length,
          onlineCount,
          lastUpdate: new Date().toISOString(),
          filterApplied: filter,
        },
      };

    } catch (error) {
      this.logger.error('Failed to get presence', { filter, error });
      throw error;
    }
  }

  /**
   * Start typing indicator for a user in a room
   */
  async startTyping(
    userId: string,
    roomId: string,
    roomType: TypingIndicator['roomType']
  ): Promise<void> {
    try {
      const key = this.getTypingKey(userId, roomId);
      const now = new Date();

      const indicator: TypingIndicator = {
        userId,
        roomId,
        roomType,
        isTyping: true,
        startedAt: now,
        lastActivity: now,
      };

      this.typingIndicators.set(key, indicator);
      await this.cacheTypingIndicator(indicator);

      // Auto-stop typing after TTL
      setTimeout(() => {
        this.stopTyping(userId, roomId);
      }, this.TYPING_TTL * 1000);

      // Broadcast typing start to room participants
      await this.broadcastTypingUpdate(roomId, {
        userId,
        isTyping: true,
        roomType,
        timestamp: now,
      });

      this.logger.debug('Typing started', { userId, roomId, roomType });

    } catch (error) {
      this.logger.error('Failed to start typing', { userId, roomId, error });
      throw error;
    }
  }

  /**
   * Stop typing indicator for a user in a room
   */
  async stopTyping(userId: string, roomId: string): Promise<void> {
    try {
      const key = this.getTypingKey(userId, roomId);
      const indicator = this.typingIndicators.get(key);

      if (indicator) {
        indicator.isTyping = false;
        this.typingIndicators.delete(key);
        
        // Clean up from cache
        await redis.del(`typing:${key}`);

        // Broadcast typing stop to room participants
        await this.broadcastTypingUpdate(roomId, {
          userId,
          isTyping: false,
          roomType: indicator.roomType,
          timestamp: new Date(),
        });

        this.logger.debug('Typing stopped', { userId, roomId });
      }

    } catch (error) {
      this.logger.error('Failed to stop typing', { userId, roomId, error });
      throw error;
    }
  }

  /**
   * Get typing indicators for a room
   */
  async getTypingIndicators(roomId: string): Promise<Array<{
    userId: string;
    user?: {
      id: string;
      name: string;
      avatar?: string;
    };
    startedAt: Date;
  }>> {
    try {
      const typingUsers: Array<{
        userId: string;
        startedAt: Date;
      }> = [];

      for (const [key, indicator] of this.typingIndicators) {
        if (indicator.roomId === roomId && indicator.isTyping) {
          typingUsers.push({
            userId: indicator.userId,
            startedAt: indicator.startedAt,
          });
        }
      }

      // Enrich with user information
      const enrichedUsers = await Promise.all(
        typingUsers.map(async (item) => {
          const user = await this.getUserInfo(item.userId);
          return {
            userId: item.userId,
            user,
            startedAt: item.startedAt,
          };
        })
      );

      return enrichedUsers;

    } catch (error) {
      this.logger.error('Failed to get typing indicators', { roomId, error });
      return [];
    }
  }

  /**
   * Mark user as offline
   */
  async setUserOffline(userId: string): Promise<void> {
    try {
      await this.updatePresence({
        userId,
        status: 'offline',
        activity: { type: 'idle' },
      });

      // Clean up any active typing indicators
      for (const [key, indicator] of this.typingIndicators) {
        if (indicator.userId === userId && indicator.isTyping) {
          await this.stopTyping(userId, indicator.roomId);
        }
      }

      this.logger.info('User marked as offline', { userId });

    } catch (error) {
      this.logger.error('Failed to set user offline', { userId, error });
      throw error;
    }
  }

  /**
   * Bulk update presence for multiple users
   */
  async bulkUpdatePresence(input: BulkPresenceUpdateInput): Promise<void> {
    try {
      const { userIds, updates } = input;

      if (userIds.length > this.BULK_UPDATE_SIZE) {
        throw new Error(`Cannot update more than ${this.BULK_UPDATE_SIZE} users at once`);
      }

      const now = new Date();
      const promises = userIds.map(userId => 
        this.updatePresence({
          userId,
          ...updates,
        })
      );

      await Promise.allSettled(promises);

      this.logger.debug('Bulk presence update completed', {
        userCount: userIds.length,
        updates,
      });

    } catch (error) {
      this.logger.error('Failed to bulk update presence', { input, error });
      throw error;
    }
  }

  /**
   * Get online friends/contacts for a user
   */
  async getOnlineContacts(userId: string, limit: number = 20): Promise<PresenceResponse> {
    try {
      // Get user's friends/contacts (this would depend on your user relationship system)
      // For now, we'll get all online users
      const filter: PresenceFilter = {
        status: ['online'],
        limit,
      };

      const presence = await this.getPresence(filter);

      // Filter out the requesting user
      presence.users = presence.users.filter(u => u.presence.userId !== userId);

      return presence;

    } catch (error) {
      this.logger.error('Failed to get online contacts', { userId, error });
      throw error;
    }
  }

  /**
   * Track user activity for analytics
   */
  async trackUserActivity(userId: string, activity: {
    type: string;
    data: any;
    duration?: number;
  }): Promise<void> {
    try {
      // Store activity for analytics
      await prisma.userActivity.create({
        data: {
          userId,
          type: activity.type,
          metadata: {
            ...activity.data,
            duration: activity.duration,
            timestamp: new Date(),
          },
        },
      });

      // Update presence if it's a significant activity
      if (['reading_started', 'reading_completed', 'search_performed', 'discussion_created'].includes(activity.type)) {
        await this.updatePresence({
          userId,
          activity: {
            type: this.mapActivityType(activity.type),
            data: activity.data,
          },
        });
      }

      this.logger.debug('User activity tracked', {
        userId,
        activityType: activity.type,
        duration: activity.duration,
      });

    } catch (error) {
      this.logger.error('Failed to track user activity', { userId, activity, error });
      // Don't throw - activity tracking shouldn't break user flow
    }
  }

  /**
   * Get presence statistics
   */
  async getPresenceStats(): Promise<{
    totalUsers: number;
    onlineUsers: number;
    awayUsers: number;
    busyUsers: number;
    offlineUsers: number;
    activeActivities: Record<string, number>;
    averageSessionTime: number;
    topActivePages: Array<{ page: string; count: number }>;
  }> {
    try {
      const allUsers = Array.from(this.presenceCache.values());

      const stats = {
        totalUsers: allUsers.length,
        onlineUsers: allUsers.filter(u => u.status === 'online').length,
        awayUsers: allUsers.filter(u => u.status === 'away').length,
        busyUsers: allUsers.filter(u => u.status === 'busy').length,
        offlineUsers: allUsers.filter(u => u.status === 'offline').length,
        activeActivities: {} as Record<string, number>,
        averageSessionTime: 0,
        topActivePages: [] as Array<{ page: string; count: number }>,
      };

      // Count activities
      const activities = allUsers
        .filter(u => u.currentActivity)
        .map(u => u.currentActivity!.type);

      stats.activeActivities = activities.reduce((acc, activity) => {
        acc[activity] = (acc[activity] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

      // Get top active pages
      const pageCounts = allUsers
        .filter(u => u.location)
        .reduce((acc, user) => {
          const page = user.location!.page;
          acc[page] = (acc[page] || 0) + 1;
          return acc;
        }, {} as Record<string, number>);

      stats.topActivePages = Object.entries(pageCounts)
        .map(([page, count]) => ({ page, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);

      return stats;

    } catch (error) {
      this.logger.error('Failed to get presence stats', { error });
      throw error;
    }
  }

  /**
   * Cache presence data in Redis
   */
  private async cachePresence(presence: UserPresence): Promise<void> {
    try {
      const cacheKey = `presence:${presence.userId}`;
      const serialized = JSON.stringify(presence);
      
      // Set with TTL for automatic expiration
      await redis.setex(cacheKey, this.PRESENCE_TTL, serialized);
    } catch (error) {
      this.logger.error('Failed to cache presence', { userId: presence.userId, error });
    }
  }

  /**
   * Cache typing indicator in Redis
   */
  private async cacheTypingIndicator(indicator: TypingIndicator): Promise<void> {
    try {
      const cacheKey = `typing:${this.getTypingKey(indicator.userId, indicator.roomId)}`;
      const serialized = JSON.stringify(indicator);
      
      await redis.setex(cacheKey, this.TYPING_TTL, serialized);
    } catch (error) {
      this.logger.error('Failed to cache typing indicator', { 
        userId: indicator.userId, 
        roomId: indicator.roomId, 
        error 
      });
    }
  }

  /**
   * Broadcast presence update to relevant users
   */
  private async broadcastPresenceUpdate(presence: UserPresence): Promise<void> {
    try {
      // This would integrate with the WebSocket server
      // For now, we'll log the broadcast
      this.logger.debug('Broadcasting presence update', {
        userId: presence.userId,
        status: presence.status,
        activity: presence.currentActivity?.type,
      });

      // In a real implementation:
      // 1. Identify users who should receive this presence update
      // 2. Send via WebSocket connections
      // 3. Handle offline users with push notifications

    } catch (error) {
      this.logger.error('Failed to broadcast presence update', { presence, error });
    }
  }

  /**
   * Broadcast typing update to room participants
   */
  private async broadcastTypingUpdate(roomId: string, data: any): Promise<void> {
    try {
      // This would integrate with the WebSocket server
      this.logger.debug('Broadcasting typing update', {
        roomId,
        ...data,
      });

      // In a real implementation:
      // 1. Get room participants
      // 2. Send typing indicator to their WebSocket connections

    } catch (error) {
      this.logger.error('Failed to broadcast typing update', { roomId, data, error });
    }
  }

  /**
   * Clean up expired presence and typing indicators
   */
  private cleanupExpiredData(): void {
    const now = new Date();

    // Clean up expired presence
    for (const [userId, presence] of this.presenceCache) {
      const timeSinceSeen = now.getTime() - presence.lastSeen.getTime();
      
      if (timeSinceSeen > this.PRESENCE_TTL * 1000) {
        // Mark as offline if not seen for a while
        if (presence.status !== 'offline') {
          presence.status = 'offline';
          this.presenceCache.set(userId, presence);
        }
      }
    }

    // Clean up expired typing indicators
    for (const [key, indicator] of this.typingIndicators) {
      const timeSinceActivity = now.getTime() - indicator.lastActivity.getTime();
      
      if (timeSinceActivity > this.TYPING_TTL * 1000) {
        this.typingIndicators.delete(key);
        redis.del(`typing:${key}`);
      }
    }

    this.logger.debug('Cleaned up expired presence and typing data');
  }

  /**
   * Get typing key for storage
   */
  private getTypingKey(userId: string, roomId: string): string {
    return `${userId}:${roomId}`;
  }

  /**
   * Get user information for presence display
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
   * Map activity type to presence activity
   */
  private mapActivityType(activityType: string): UserPresence['currentActivity']['type'] {
    switch (activityType) {
      case 'reading_started':
      case 'reading_progress':
        return 'reading';
      case 'search_performed':
        return 'searching';
      case 'page_viewed':
        return 'browsing';
      case 'discussion_created':
      case 'reply_posted':
        return 'discussing';
      default:
        return 'idle';
    }
  }

  /**
   * Initialize presence from cached data on startup
   */
  async initializePresenceFromCache(): Promise<void> {
    try {
      // This would load presence data from Redis cache
      // For now, we'll just log the initialization
      this.logger.info('Presence system initialized');

      // In a real implementation:
      // 1. Load all cached presence data from Redis
      // 2. Restore typing indicators
      // 3. Set up periodic cleanup

    } catch (error) {
      this.logger.error('Failed to initialize presence from cache', { error });
    }
  }
}