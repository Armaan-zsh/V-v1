import { Matrix } from 'ml-matrix';
import { z } from 'zod';
import { OpenAIClient } from './OpenAIClient';
import { prisma } from '../database/prisma';
import { redis } from '../database/redis';

// Types for recommendation system
export interface UserItemRating {
  userId: string;
  itemId: string;
  rating: number; // 1-5 scale
  timestamp: Date;
}

export interface Recommendation {
  itemId: string;
  score: number;
  reason: 'collaborative' | 'content' | 'trending' | 'new';
  confidence: number;
  item?: {
    id: string;
    title: string;
    author?: string;
    url?: string;
    tags?: string[];
  };
}

export interface RecommendationConfig {
  maxRecommendations: number;
  collaborativeWeight: number;
  contentWeight: number;
  trendingWeight: number;
  minRatingsForUser: number;
  minRatingsForItem: number;
  similarityThreshold: number;
}

export interface UserSimilarity {
  userId: string;
  similarity: number;
  commonItems: number;
}

export interface ItemRecommendation {
  itemId: string;
  predictedRating: number;
  reasons: string[];
  basedOnItems: string[];
}

// Validation schemas
export const UserItemRatingSchema = z.object({
  userId: z.string().uuid(),
  itemId: z.string().uuid(),
  rating: z.number().min(1).max(5),
  timestamp: z.date().default(() => new Date()),
});

export const RecommendationRequestSchema = z.object({
  userId: z.string().uuid(),
  config: z.object({
    maxRecommendations: z.number().min(1).max(50).default(10),
    excludeViewed: z.boolean().default(true),
    categories: z.array(z.string()).optional(),
    timeframe: z.enum(['week', 'month', 'all']).default('month'),
  }).default({}),
});

export class RecommendationService {
  private aiClient: OpenAIClient;
  private defaultConfig: RecommendationConfig = {
    maxRecommendations: 10,
    collaborativeWeight: 0.6,
    contentWeight: 0.3,
    trendingWeight: 0.1,
    minRatingsForUser: 5,
    minRatingsForItem: 3,
    similarityThreshold: 0.1,
  };

  constructor() {
    this.aiClient = new OpenAIClient();
  }

  /**
   * Generate personalized recommendations for a user
   */
  async getRecommendations(userId: string, customConfig?: Partial<RecommendationConfig>): Promise<Recommendation[]> {
    try {
      const config = { ...this.defaultConfig, ...customConfig };
      
      // Check cache first
      const cacheKey = `recommendations:${userId}:${JSON.stringify(config)}`;
      const cached = await redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }

      // Get user profile and history
      const userProfile = await this.getUserProfile(userId);
      if (!userProfile || userProfile.ratings.length < config.minRatingsForUser) {
        // Cold start - use trending and popular items
        return this.getColdStartRecommendations(config);
      }

      // Generate recommendations using multiple approaches
      const [collaborativeRecs, contentRecs, trendingRecs] = await Promise.all([
        this.getCollaborativeRecommendations(userId, config),
        this.getContentBasedRecommendations(userId, userProfile, config),
        this.getTrendingRecommendations(config),
      ]);

      // Combine and rank recommendations
      const combinedRecs = this.combineRecommendations(
        collaborativeRecs,
        contentRecs,
        trendingRecs,
        config
      );

      // Get item details for top recommendations
      const topRecs = combinedRecs.slice(0, config.maxRecommendations);
      const detailedRecs = await this.enrichRecommendationsWithDetails(topRecs);

      // Cache for 1 hour
      await redis.setex(cacheKey, 3600, JSON.stringify(detailedRecs));

      return detailedRecs;
    } catch (error) {
      console.error('Error generating recommendations:', error);
      // Fallback to trending items
      return this.getTrendingRecommendations(config);
    }
  }

  /**
   * Collaborative filtering using matrix factorization (SVD)
   */
  private async getCollaborativeRecommendations(
    userId: string,
    config: RecommendationConfig
  ): Promise<ItemRecommendation[]> {
    try {
      // Get user-item rating matrix
      const ratingData = await this.buildUserItemMatrix();
      
      // Convert to matrix format
      const userIds = Array.from(ratingData.keys());
      const itemIds = Array.from(
        new Set(Array.from(ratingData.values()).flatMap(userData => Array.from(userData.keys())))
      );

      if (userIds.length === 0 || itemIds.length === 0) {
        return [];
      }

      // Create user-item matrix
      const matrix = new Matrix(
        userIds.map(userId => 
          itemIds.map(itemId => ratingData.get(userId)?.get(itemId) || 0)
        )
      );

      const userIndex = userIds.indexOf(userId);
      if (userIndex === -1) return [];

      // Apply SVD for dimensionality reduction (simplified)
      const factors = 10; // Latent factors
      const svd = matrix.svd();
      const userFactors = svd.getU().submatrix(0, userIds.length - 1, 0, factors - 1);
      const itemFactors = svd.getV().submatrix(0, itemIds.length - 1, 0, factors - 1);
      const singularValues = svd.getS().subdiagonal();

      // Calculate user preferences for items
      const userVector = userFactors.getRow(userIndex);
      const predictions: ItemRecommendation[] = [];

      for (let itemIndex = 0; itemIndex < itemIds.length; itemIndex++) {
        const itemId = itemIds[itemIndex];
        
        // Skip if user has already rated this item
        if (ratingData.get(userId)?.has(itemId)) continue;

        // Calculate predicted rating
        let prediction = 0;
        for (let k = 0; k < factors; k++) {
          prediction += userVector[k] * itemFactors.getRow(itemIndex)[k] * singularValues[k];
        }

        // Clamp to valid range
        prediction = Math.max(1, Math.min(5, prediction));

        // Calculate confidence based on user's similarity to those who rated this item
        const confidence = await this.calculateRecommendationConfidence(userId, itemId, ratingData);

        predictions.push({
          itemId,
          predictedRating: prediction,
          confidence,
          reasons: [`Collaborative filtering - users with similar preferences rated this highly`],
          basedOnItems: this.getInfluentialItems(userId, itemId, ratingData, userIds, itemIds),
        });
      }

      // Sort by predicted rating * confidence
      return predictions
        .sort((a, b) => (b.predictedRating * b.confidence) - (a.predictedRating * a.confidence))
        .slice(0, config.maxRecommendations);

    } catch (error) {
      console.error('Error in collaborative filtering:', error);
      return [];
    }
  }

  /**
   * Content-based filtering using item features (tags, embeddings)
   */
  private async getContentBasedRecommendations(
    userId: string,
    userProfile: any,
    config: RecommendationConfig
  ): Promise<ItemRecommendation[]> {
    try {
      // Get user's preferred tags based on historical ratings
      const userTagPreferences = this.calculateUserTagPreferences(userProfile.ratings);

      // Find items with similar tags
      const candidateItems = await prisma.item.findMany({
        where: {
          embeddingProcessedAt: { not: null }, // Only items with embeddings
          id: { notIn: userProfile.ratings.map((r: any) => r.itemId) }, // Exclude rated items
        },
        include: {
          tags: true,
        },
        take: 100, // Limit for performance
      });

      const recommendations: ItemRecommendation[] = [];

      for (const item of candidateItems) {
        if (!item.embedding) continue;

        // Calculate content similarity
        const contentScore = this.calculateContentSimilarity(
          userTagPreferences,
          item.tags.map(t => t.name)
        );

        if (contentScore > 0.1) { // Minimum threshold
          recommendations.push({
            itemId: item.id,
            predictedRating: 1 + (contentScore * 4), // Scale to 1-5
            confidence: Math.min(0.9, contentScore + 0.3),
            reasons: [`Content similarity - matches your interests in ${item.tags.slice(0, 3).map(t => t.name).join(', ')}`],
            basedOnItems: [],
          });
        }
      }

      return recommendations
        .sort((a, b) => b.predictedRating - a.predictedRating)
        .slice(0, config.maxRecommendations);

    } catch (error) {
      console.error('Error in content-based filtering:', error);
      return [];
    }
  }

  /**
   * Get trending items based on recent activity
   */
  private async getTrendingRecommendations(
    config: RecommendationConfig
  ): Promise<ItemRecommendation[]> {
    try {
      // Get items with high recent engagement
      const trendingItems = await prisma.item.findMany({
        where: {
          readingActivities: {
            some: {
              createdAt: {
                gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), // Last 7 days
              },
            },
          },
        },
        include: {
          readingActivities: {
            where: {
              createdAt: {
                gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
              },
            },
          },
          tags: true,
        },
        orderBy: {
          readingActivities: {
            _count: 'desc',
          },
        },
        take: config.maxRecommendations * 2, // Get extra for ranking
      });

      return trendingItems.map(item => ({
        itemId: item.id,
        predictedRating: 3.5, // Neutral rating for trending
        confidence: 0.7,
        reasons: ['Trending - popular among other readers'],
        basedOnItems: [],
      }));

    } catch (error) {
      console.error('Error in trending recommendations:', error);
      return [];
    }
  }

  /**
   * Combine recommendations from different algorithms
   */
  private combineRecommendations(
    collaborative: ItemRecommendation[],
    content: ItemRecommendation[],
    trending: ItemRecommendation[],
    config: RecommendationConfig
  ): Array<ItemRecommendation & { finalScore: number }> {
    const combinedMap = new Map<string, ItemRecommendation & { finalScore: number }>();

    // Process collaborative filtering results
    for (const rec of collaborative) {
      const finalScore = rec.predictedRating * config.collaborativeWeight;
      combinedMap.set(rec.itemId, {
        ...rec,
        finalScore: finalScore * rec.confidence,
      });
    }

    // Add content-based results
    for (const rec of content) {
      const finalScore = rec.predictedRating * config.contentWeight;
      const existing = combinedMap.get(rec.itemId);
      
      if (existing) {
        existing.finalScore += finalScore * rec.confidence;
        existing.reasons.push(...rec.reasons);
      } else {
        combinedMap.set(rec.itemId, {
          ...rec,
          finalScore: finalScore * rec.confidence,
        });
      }
    }

    // Add trending results
    for (const rec of trending) {
      const finalScore = rec.predictedRating * config.trendingWeight;
      const existing = combinedMap.get(rec.itemId);
      
      if (existing) {
        existing.finalScore += finalScore * rec.confidence;
        existing.reasons.push(...rec.reasons);
      } else {
        combinedMap.set(rec.itemId, {
          ...rec,
          finalScore: finalScore * rec.confidence,
        });
      }
    }

    // Sort by final score
    return Array.from(combinedMap.values())
      .sort((a, b) => b.finalScore - a.finalScore);
  }

  /**
   * Enrich recommendations with item details
   */
  private async enrichRecommendationsWithDetails(
    recommendations: Array<ItemRecommendation & { finalScore: number }>
  ): Promise<Recommendation[]> {
    if (recommendations.length === 0) return [];

    const itemIds = recommendations.map(r => r.itemId);
    
    const items = await prisma.item.findMany({
      where: { id: { in: itemIds } },
      include: {
        tags: true,
      },
    });

    return recommendations.map(rec => {
      const item = items.find(i => i.id === rec.itemId);
      return {
        itemId: rec.itemId,
        score: rec.finalScore,
        reason: this.determinePrimaryReason(rec),
        confidence: rec.confidence,
        item: item ? {
          id: item.id,
          title: item.title,
          author: item.author || undefined,
          url: item.url || undefined,
          tags: item.tags.map(t => t.name),
        } : undefined,
      };
    });
  }

  /**
   * Build user-item rating matrix from database
   */
  private async buildUserItemMatrix(): Promise<Map<string, Map<string, number>>> {
    const activities = await prisma.readingActivity.findMany({
      include: {
        user: true,
        item: true,
      },
      where: {
        progress: { gte: 0.8 }, // Only consider completed or near-completed items
      },
    });

    const ratingMap = new Map<string, Map<string, number>>();

    for (const activity of activities) {
      const userId = activity.user.id;
      const itemId = activity.item.id;
      
      // Convert engagement metrics to rating (1-5 scale)
      const rating = this.calculateRating(activity.progress, activity.timeSpent);
      
      if (!ratingMap.has(userId)) {
        ratingMap.set(userId, new Map());
      }
      
      ratingMap.get(userId)!.set(itemId, rating);
    }

    return ratingMap;
  }

  /**
   * Get user profile with ratings and preferences
   */
  private async getUserProfile(userId: string) {
    const ratings = await prisma.readingActivity.findMany({
      where: {
        userId,
        progress: { gte: 0.5 },
      },
      include: {
        item: {
          include: {
            tags: true,
          },
        },
      },
    });

    return {
      userId,
      ratings: ratings.map(r => ({
        itemId: r.itemId,
        rating: this.calculateRating(r.progress, r.timeSpent),
        tags: r.item.tags.map(t => t.name),
        timestamp: r.createdAt,
      })),
    };
  }

  /**
   * Calculate user tag preferences based on historical ratings
   */
  private calculateUserTagPreferences(ratings: any[]): Map<string, number> {
    const tagScores = new Map<string, number>();
    
    for (const rating of ratings) {
      for (const tag of rating.tags) {
        tagScores.set(tag, (tagScores.get(tag) || 0) + rating.rating);
      }
    }

    // Normalize scores
    const maxScore = Math.max(...Array.from(tagScores.values()));
    for (const [tag, score] of tagScores) {
      tagScores.set(tag, score / maxScore);
    }

    return tagScores;
  }

  /**
   * Calculate content similarity between user preferences and item tags
   */
  private calculateContentSimilarity(
    userTagPreferences: Map<string, number>,
    itemTags: string[]
  ): number {
    if (itemTags.length === 0) return 0;

    let similarity = 0;
    let totalWeight = 0;

    for (const tag of itemTags) {
      const weight = userTagPreferences.get(tag);
      if (weight) {
        similarity += weight;
        totalWeight += weight;
      }
    }

    return totalWeight > 0 ? similarity / itemTags.length : 0;
  }

  /**
   * Calculate confidence for recommendation based on user's similarity to raters
   */
  private async calculateRecommendationConfidence(
    userId: string,
    itemId: string,
    ratingData: Map<string, Map<string, number>>
  ): Promise<number> {
    const userRatings = ratingData.get(userId) || new Map();
    const itemRatings = new Map<string, number>();

    // Find users who rated this item
    for (const [otherUserId, ratings] of ratingData) {
      if (ratings.has(itemId) && otherUserId !== userId) {
        itemRatings.set(otherUserId, ratings.get(itemId)!);
      }
    }

    if (itemRatings.size === 0) return 0.3; // Low confidence for unpopular items

    // Calculate user similarity based on common ratings
    const similarities: number[] = [];
    
    for (const [otherUserId, otherRating] of itemRatings) {
      const otherUserRatings = ratingData.get(otherUserId) || new Map();
      
      // Find common items
      const commonItems = Array.from(userRatings.keys()).filter(itemId => 
        otherUserRatings.has(itemId)
      );

      if (commonItems.length >= 2) {
        // Calculate Pearson correlation
        const correlation = this.calculatePearsonCorrelation(
          commonItems.map(itemId => userRatings.get(itemId)!),
          commonItems.map(itemId => otherUserRatings.get(itemId)!)
        );
        
        if (!isNaN(correlation)) {
          similarities.push(Math.abs(correlation));
        }
      }
    }

    // Return average similarity with weighting
    const avgSimilarity = similarities.length > 0 
      ? similarities.reduce((sum, sim) => sum + sim, 0) / similarities.length
      : 0;

    // Boost confidence for items rated highly by similar users
    const avgRating = Array.from(itemRatings.values()).reduce((sum, rating) => sum + rating, 0) / itemRatings.size;
    
    return Math.min(0.95, avgSimilarity * (avgRating / 5) + 0.1);
  }

  /**
   * Calculate Pearson correlation coefficient
   */
  private calculatePearsonCorrelation(x: number[], y: number[]): number {
    const n = x.length;
    if (n !== y.length || n === 0) return 0;

    const sumX = x.reduce((sum, val) => sum + val, 0);
    const sumY = y.reduce((sum, val) => sum + val, 0);
    const sumXY = x.reduce((sum, val, i) => sum + val * y[i], 0);
    const sumX2 = x.reduce((sum, val) => sum + val * val, 0);
    const sumY2 = y.reduce((sum, val) => sum + val * val, 0);

    const numerator = n * sumXY - sumX * sumY;
    const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));

    return denominator === 0 ? 0 : numerator / denominator;
  }

  /**
   * Get items that influenced the recommendation
   */
  private getInfluentialItems(
    userId: string,
    targetItemId: string,
    ratingData: Map<string, Map<string, number>>,
    userIds: string[],
    itemIds: string[]
  ): string[] {
    const userRatings = ratingData.get(userId) || new Map();
    const targetItemRatings = new Map<string, number>();

    // Find users who rated the target item
    for (const [otherUserId, ratings] of ratingData) {
      if (ratings.has(targetItemId) && otherUserId !== userId) {
        targetItemRatings.set(otherUserId, ratings.get(targetItemId)!);
      }
    }

    // Find items that similar users rated highly
    const influentialItems: string[] = [];
    
    for (const [otherUserId, otherRating] of targetItemRatings) {
      const otherUserRatings = ratingData.get(otherUserId) || new Map();
      
      // Find items the other user rated highly (4+) that our user hasn't rated
      for (const [itemId, rating] of otherUserRatings) {
        if (rating >= 4 && !userRatings.has(itemId) && influentialItems.length < 3) {
          influentialItems.push(itemId);
        }
      }
    }

    return influentialItems;
  }

  /**
   * Convert engagement metrics to 1-5 rating
   */
  private calculateRating(progress: number, timeSpent: number): number {
    // Base rating on progress (0-1)
    let rating = progress * 5;
    
    // Boost for higher engagement (time spent)
    if (timeSpent > 60) rating += 0.5; // More than 1 hour
    else if (timeSpent > 30) rating += 0.3; // More than 30 minutes
    else if (timeSpent < 5) rating -= 0.5; // Less than 5 minutes
    
    // Clamp to valid range
    return Math.max(1, Math.min(5, rating));
  }

  /**
   * Determine primary reason for recommendation
   */
  private determinePrimaryReason(rec: ItemRecommendation & { finalScore: number }): 'collaborative' | 'content' | 'trending' | 'new' {
    if (rec.reasons.some(r => r.includes('Collaborative'))) return 'collaborative';
    if (rec.reasons.some(r => r.includes('Content similarity'))) return 'content';
    if (rec.reasons.some(r => r.includes('Trending'))) return 'trending';
    return 'new';
  }

  /**
   * Get cold start recommendations for new users
   */
  private async getColdStartRecommendations(config: RecommendationConfig): Promise<Recommendation[]> {
    try {
      // Get popular items across all users
      const popularItems = await prisma.item.findMany({
        include: {
          readingActivities: true,
          tags: true,
        },
        orderBy: {
          readingActivities: {
            _count: 'desc',
          },
        },
        take: config.maxRecommendations,
      });

      return popularItems.map(item => ({
        itemId: item.id,
        score: item.readingActivities.length / 100, // Normalize
        reason: 'trending' as const,
        confidence: 0.6,
        item: {
          id: item.id,
          title: item.title,
          author: item.author || undefined,
          url: item.url || undefined,
          tags: item.tags.map(t => t.name),
        },
      }));
    } catch (error) {
      console.error('Error getting cold start recommendations:', error);
      return [];
    }
  }
}