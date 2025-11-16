import { serve } from "inngest/h3";
import { prisma } from "../database/prisma";
import { redis } from "../database/redis";
import { RecommendationService } from "../ai/RecommendationService";
import pino from 'pino';

// Initialize logger
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV === 'development' ? {
    target: 'pino-pretty',
    options: { colorize: true }
  } : undefined
});

/**
 * Generate and cache daily recommendations for all active users
 * This runs as a background job to pre-compute recommendations
 */
export const generateDailyRecommendations = serve({
  id: "generate-daily-recommendations",
  name: "Generate Daily Recommendations",
  concurrency: 2,
  maxConcurrency: 5,
  retries: 2,
  onFailure: async ({ error, event, step }) => {
    logger.error('Daily recommendation generation failed', {
      error: error.message,
      eventId: event.id,
      step: step?.name
    });
  },
}, async (event) => {
  const { userId, preferences } = event.data;
  
  try {
    logger.info('Starting daily recommendation generation', { userId });
    
    const recommendationService = new RecommendationService();
    
    // Generate comprehensive recommendations
    const recommendations = await recommendationService.getRecommendations(userId, {
      maxRecommendations: 20, // Generate more for caching
      minRatingsForUser: preferences?.minRatings || 5,
    });
    
    // Cache recommendations for different time windows
    const cacheKeys = [
      `recommendations:daily:${userId}`,
      `recommendations:weekly:${userId}`,
      `recommendations:monthly:${userId}`,
    ];
    
    const ttlValues = [24 * 60 * 60, 7 * 24 * 60 * 60, 30 * 24 * 60 * 60]; // 1 day, 1 week, 1 month
    
    for (let i = 0; i < cacheKeys.length; i++) {
      const cacheKey = cacheKeys[i];
      const ttl = ttlValues[i];
      
      // For weekly/monthly, filter out very recent recommendations
      let filteredRecs = recommendations;
      if (i > 0) { // weekly or monthly
        filteredRecs = recommendations.filter(rec => rec.confidence < 0.9 || Math.random() > 0.7);
      }
      
      await redis.setex(cacheKey, ttl, JSON.stringify(filteredRecs));
      logger.debug('Cached recommendations', { userId, cacheKey, count: filteredRecs.length });
    }
    
    // Update user recommendation profile
    await updateUserRecommendationProfile(userId, recommendations);
    
    // Record generation metrics
    await recordGenerationMetrics(userId, recommendations.length);
    
    logger.info('Daily recommendation generation completed', { 
      userId, 
      totalGenerated: recommendations.length 
    });
    
    return {
      success: true,
      userId,
      recommendationsGenerated: recommendations.length,
      cachedKeys: cacheKeys.length,
    };
    
  } catch (error) {
    logger.error('Daily recommendation generation failed', { 
      userId, 
      error: error.message,
      stack: error.stack 
    });
    throw error;
  }
});

/**
 * Batch generate recommendations for multiple users
 */
export const batchGenerateRecommendations = serve({
  id: "batch-generate-recommendations",
  name: "Batch Generate Recommendations",
  concurrency: 1,
  maxConcurrency: 3,
  retries: 1,
  onFailure: async ({ error, event, step }) => {
    logger.error('Batch recommendation generation failed', {
      error: error.message,
      eventId: event.id,
      step: step?.name
    });
  },
}, async (event) => {
  const { userIds, batchSize = 50 } = event.data;
  
  const results = {
    successful: [] as string[],
    failed: [] as { userId: string; error: string }[],
    totalProcessed: 0,
    totalGenerated: 0,
  };
  
  logger.info('Starting batch recommendation generation', { 
    userIds: userIds.length, 
    batchSize 
  });
  
  // Process users in batches to avoid overwhelming the system
  for (let i = 0; i < userIds.length; i += batchSize) {
    const batch = userIds.slice(i, i + batchSize);
    
    try {
      const batchPromises = batch.map(async (userId) => {
        try {
          const recommendationService = new RecommendationService();
          
          const recommendations = await recommendationService.getRecommendations(userId, {
            maxRecommendations: 15,
            minRatingsForUser: 3,
          });
          
          // Cache with shorter TTL for batch processing
          const cacheKey = `recommendations:batch:${userId}`;
          await redis.setex(cacheKey, 6 * 60 * 60, JSON.stringify(recommendations)); // 6 hours
          
          results.successful.push(userId);
          results.totalGenerated += recommendations.length;
          
          return { userId, success: true, count: recommendations.length };
          
        } catch (error) {
          results.failed.push({ userId, error: error.message });
          logger.error('Failed to generate recommendations for user', { 
            userId, 
            error: error.message 
          });
          return { userId, success: false, error: error.message };
        }
      });
      
      const batchResults = await Promise.allSettled(batchPromises);
      
      // Process results
      for (const result of batchResults) {
        if (result.status === 'fulfilled') {
          results.totalProcessed++;
        }
      }
      
      // Small delay between batches to prevent rate limiting
      if (i + batchSize < userIds.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
    } catch (error) {
      logger.error('Batch processing failed', { 
        batchIndex: Math.floor(i / batchSize),
        error: error.message 
      });
    }
  }
  
  logger.info('Batch recommendation generation completed', {
    totalProcessed: results.totalProcessed,
    successful: results.successful.length,
    failed: results.failed.length,
    totalGenerated: results.totalGenerated,
  });
  
  return results;
});

/**
 * Update user's recommendation profile for faster future queries
 */
async function updateUserRecommendationProfile(userId: string, recommendations: any[]) {
  try {
    // Calculate user preference vectors
    const tagPreferences = new Map<string, number>();
    const authorPreferences = new Map<string, number>();
    
    // Analyze recommended items to build preference profile
    for (const rec of recommendations.slice(0, 20)) { // Top 20 recommendations
      if (rec.item?.tags) {
        for (const tag of rec.item.tags) {
          const current = tagPreferences.get(tag) || 0;
          tagPreferences.set(tag, current + (rec.score * rec.confidence));
        }
      }
      
      if (rec.item?.author) {
        const current = authorPreferences.get(rec.item.author) || 0;
        authorPreferences.set(rec.item.author, current + (rec.score * rec.confidence));
      }
    }
    
    // Normalize preferences
    const maxTagScore = Math.max(...Array.from(tagPreferences.values()));
    const maxAuthorScore = Math.max(...Array.from(authorPreferences.values()));
    
    const normalizedTags = new Map<string, number>();
    const normalizedAuthors = new Map<string, number>();
    
    for (const [tag, score] of tagPreferences) {
      normalizedTags.set(tag, score / maxTagScore);
    }
    
    for (const [author, score] of authorPreferences) {
      normalizedAuthors.set(author, score / maxAuthorScore);
    }
    
    // Store in cache for quick access
    const profileKey = `user:recommendation-profile:${userId}`;
    const profile = {
      tagPreferences: Object.fromEntries(normalizedTags),
      authorPreferences: Object.fromEntries(normalizedAuthors),
      lastUpdated: new Date(),
      recommendationCount: recommendations.length,
      avgConfidence: recommendations.reduce((sum, r) => sum + r.confidence, 0) / recommendations.length,
    };
    
    await redis.setex(profileKey, 7 * 24 * 60 * 60, JSON.stringify(profile)); // 1 week TTL
    
  } catch (error) {
    logger.error('Failed to update recommendation profile', { 
      userId, 
      error: error.message 
    });
  }
}

/**
 * Record metrics for recommendation generation
 */
async function recordGenerationMetrics(userId: string, recommendationCount: number) {
  try {
    // Store metrics in database for analysis
    await prisma.userInteraction.create({
      data: {
        userId,
        type: 'recommendation_generation',
        metadata: {
          count: recommendationCount,
          timestamp: new Date(),
          algorithm: 'hybrid',
        },
      },
    }).catch(() => {
      // Ignore if table doesn't exist or other errors
    });
    
    // Update user statistics
    await prisma.user.update({
      where: { id: userId },
      data: {
        updatedAt: new Date(),
        // Could add recommendation generation timestamp
      },
    }).catch(() => {
      // Ignore if user doesn't exist or other errors
    });
    
  } catch (error) {
    logger.error('Failed to record generation metrics', { 
      userId, 
      error: error.message 
    });
  }
}

/**
 * Schedule daily recommendation generation for all active users
 */
export async function scheduleDailyRecommendations() {
  try {
    // Get all users who have been active in the last 30 days
    const activeUsers = await prisma.user.findMany({
      where: {
        readingActivities: {
          some: {
            createdAt: {
              gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
            },
          },
        },
      },
      select: {
        id: true,
        readingActivities: {
          where: {
            createdAt: {
              gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
            },
          },
          select: {
            progress: true,
          },
        },
      },
    });
    
    if (activeUsers.length === 0) {
      logger.info('No active users found for daily recommendations');
      return;
    }
    
    // Filter users who need new recommendations (haven't received any in 24h)
    const usersNeedingUpdates = [];
    
    for (const user of activeUsers) {
      const cacheKey = `recommendations:daily:${user.id}`;
      const cached = await redis.get(cacheKey);
      
      if (!cached) {
        usersNeedingUpdates.push({
          userId: user.id,
          preferences: {
            minRatings: Math.max(3, user.readingActivities.length),
          },
        });
      }
    }
    
    logger.info(`Found ${usersNeedingUpdates.length} users needing recommendation updates`);
    
    // Generate recommendations for users who need updates
    if (usersNeedingUpdates.length > 0) {
      // Process in batches to avoid overwhelming the system
      const batchSize = 25;
      for (let i = 0; i < usersNeedingUpdates.length; i += batchSize) {
        const batch = usersNeedingUpdates.slice(i, i + batchSize);
        
        // Send individual events for each user (or use batchGenerateRecommendations)
        const eventPromises = batch.map(userData => 
          // In a real implementation, you'd use inngest.send()
          generateDailyRecommendations({
            data: userData,
          })
        );
        
        await Promise.allSettled(eventPromises);
        
        // Small delay between batches
        if (i + batchSize < usersNeedingUpdates.length) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    }
    
  } catch (error) {
    logger.error('Failed to schedule daily recommendations', { 
      error: error.message 
    });
  }
}

/**
 * Clean up old recommendation data
 */
export async function cleanupOldRecommendations() {
  try {
    // Clean up old cached recommendations (older than 7 days)
    const patterns = [
      'recommendations:*',
      'user:recommendation-profile:*',
    ];
    
    for (const pattern of patterns) {
      const keys = await redis.keys(pattern);
      const oldKeys = keys.filter(key => {
        // Get TTL to determine if key is old
        const ttl = redis.ttl(key);
        return ttl <= 0; // Keys without TTL or expired
      });
      
      if (oldKeys.length > 0) {
        await redis.del(...oldKeys);
        logger.info(`Cleaned up ${oldKeys.length} old recommendation keys`, { pattern });
      }
    }
    
    // Clean up old user interaction records (older than 90 days)
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    
    await prisma.userInteraction.deleteMany({
      where: {
        type: { startsWith: 'recommendation_' },
        createdAt: { lt: ninetyDaysAgo },
      },
    }).catch(() => {
      // Ignore if table doesn't exist
    });
    
  } catch (error) {
    logger.error('Failed to cleanup old recommendations', { 
      error: error.message 
    });
  }
}

/**
 * Get recommendation performance metrics
 */
export async function getRecommendationMetrics() {
  try {
    const metrics = {
      totalUsers: 0,
      activeUsersLast30Days: 0,
      avgRecommendationsPerUser: 0,
      totalCachedRecommendations: 0,
      cacheHitRate: 0,
    };
    
    // Count total users
    const totalUsers = await prisma.user.count();
    metrics.totalUsers = totalUsers;
    
    // Count active users in last 30 days
    const activeUsers = await prisma.user.count({
      where: {
        readingActivities: {
          some: {
            createdAt: {
              gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
            },
          },
        },
      },
    });
    metrics.activeUsersLast30Days = activeUsers;
    
    // Count cached recommendations
    const recommendationKeys = await redis.keys('recommendations:*');
    metrics.totalCachedRecommendations = recommendationKeys.length;
    
    // Calculate average recommendations per user (if we have user interaction data)
    // This would require more complex queries in a real implementation
    
    return metrics;
    
  } catch (error) {
    logger.error('Failed to get recommendation metrics', { 
      error: error.message 
    });
    return {
      totalUsers: 0,
      activeUsersLast30Days: 0,
      avgRecommendationsPerUser: 0,
      totalCachedRecommendations: 0,
      cacheHitRate: 0,
    };
  }
}