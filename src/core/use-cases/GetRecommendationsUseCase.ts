import { z } from 'zod';
import { RecommendationService, Recommendation } from '../../infrastructure/ai/RecommendationService';
import { prisma } from '../../infrastructure/database/prisma';
import { AppError } from '../../shared/errors/AppError';

export interface GetRecommendationsInput {
  userId: string;
  maxRecommendations?: number;
  excludeViewed?: boolean;
  categories?: string[];
  timeframe?: 'week' | 'month' | 'all';
  reason?: 'collaborative' | 'content' | 'trending' | 'new';
}

export interface GetRecommendationsOutput {
  recommendations: Recommendation[];
  metadata: {
    totalGenerated: number;
    generationTimeMs: number;
    algorithm: 'collaborative' | 'content' | 'hybrid';
    userProfile: {
      totalRatings: number;
      averageRating: number;
      primaryInterests: string[];
    };
  };
}

// Validation schema
export const GetRecommendationsInputSchema = z.object({
  userId: z.string().uuid(),
  maxRecommendations: z.number().min(1).max(50).optional(),
  excludeViewed: z.boolean().default(true),
  categories: z.array(z.string()).optional(),
  timeframe: z.enum(['week', 'month', 'all']).default('month'),
  reason: z.enum(['collaborative', 'content', 'trending', 'new']).optional(),
});

export class GetRecommendationsUseCase {
  private recommendationService: RecommendationService;

  constructor() {
    this.recommendationService = new RecommendationService();
  }

  async execute(input: GetRecommendationsInput): Promise<GetRecommendationsOutput> {
    try {
      // Validate input
      const validatedInput = GetRecommendationsInputSchema.parse(input);
      
      const startTime = Date.now();

      // Check if user exists
      const user = await prisma.user.findUnique({
        where: { id: validatedInput.userId },
        select: { id: true, name: true },
      });

      if (!user) {
        throw new AppError('USER_NOT_FOUND', `User with ID ${validatedInput.userId} not found`);
      }

      // Get user's profile and reading history
      const userProfile = await this.getUserProfile(validatedInput.userId);

      // Generate recommendations
      const recommendations = await this.recommendationService.getRecommendations(
        validatedInput.userId,
        {
          maxRecommendations: validatedInput.maxRecommendations || 10,
          minRatingsForUser: Math.max(3, userProfile.totalRatings), // Adjust based on user experience
        }
      );

      // Filter recommendations based on user preferences
      const filteredRecs = this.filterRecommendations(recommendations, validatedInput);

      const generationTime = Date.now() - startTime;

      return {
        recommendations: filteredRecs,
        metadata: {
          totalGenerated: filteredRecs.length,
          generationTimeMs: generationTime,
          algorithm: this.determineAlgorithm(userProfile.totalRatings),
          userProfile: {
            totalRatings: userProfile.totalRatings,
            averageRating: userProfile.averageRating,
            primaryInterests: userProfile.primaryInterests,
          },
        },
      };

    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      
      console.error('Error in GetRecommendationsUseCase:', error);
      throw new AppError('RECOMMENDATION_GENERATION_FAILED', 'Failed to generate recommendations');
    }
  }

  /**
   * Get user profile including reading history and preferences
   */
  private async getUserProfile(userId: string) {
    const activities = await prisma.readingActivity.findMany({
      where: {
        userId,
        progress: { gte: 0.5 }, // Only consider substantial reading activity
      },
      include: {
        item: {
          include: {
            tags: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
      take: 100, // Limit for performance
    });

    if (activities.length === 0) {
      return {
        totalRatings: 0,
        averageRating: 0,
        primaryInterests: [],
        recentActivity: [],
        categories: new Set<string>(),
      };
    }

    // Calculate average rating
    const ratings = activities.map(activity => 
      this.calculateEngagementScore(activity.progress, activity.timeSpent)
    );
    const averageRating = ratings.reduce((sum, rating) => sum + rating, 0) / ratings.length;

    // Extract primary interests from most rated tags
    const tagCounts = new Map<string, number>();
    for (const activity of activities) {
      for (const tag of activity.item.tags) {
        tagCounts.set(tag.name, (tagCounts.get(tag.name) || 0) + 1);
      }
    }

    const primaryInterests = Array.from(tagCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([tag]) => tag);

    // Extract categories
    const categories = new Set<string>();
    for (const activity of activities) {
      for (const tag of activity.item.tags) {
        // Assume first part of tag represents category (e.g., "tech-ai", "business-finance")
        const category = tag.name.split('-')[0];
        if (category && category.length > 2) {
          categories.add(category);
        }
      }
    }

    return {
      totalRatings: activities.length,
      averageRating: Math.round(averageRating * 10) / 10,
      primaryInterests,
      recentActivity: activities.slice(0, 10).map(activity => ({
        itemId: activity.itemId,
        title: activity.item.title,
        progress: activity.progress,
        timeSpent: activity.timeSpent,
        completed: activity.progress >= 0.9,
      })),
      categories: Array.from(categories),
    };
  }

  /**
   * Filter recommendations based on user preferences and constraints
   */
  private filterRecommendations(
    recommendations: Recommendation[],
    input: GetRecommendationsInput
  ): Recommendation[] {
    let filtered = recommendations;

    // Filter by reason if specified
    if (input.reason) {
      filtered = filtered.filter(rec => rec.reason === input.reason);
    }

    // Filter by categories if specified
    if (input.categories && input.categories.length > 0) {
      filtered = filtered.filter(rec => 
        rec.item?.tags?.some(tag => 
          input.categories!.some(category => 
            tag.toLowerCase().includes(category.toLowerCase()) ||
            category.toLowerCase().includes(tag.toLowerCase())
          )
        )
      );
    }

    // Exclude already viewed items if requested
    if (input.excludeViewed) {
      // This would require user reading history check
      // For now, we'll filter out items with very low confidence
      filtered = filtered.filter(rec => rec.confidence > 0.3);
    }

    // Filter by timeframe (for trending items)
    if (input.timeframe) {
      // This would need metadata about when items became trending
      // For now, we'll rely on the confidence scores
    }

    return filtered.slice(0, input.maxRecommendations || 10);
  }

  /**
   * Determine which algorithm to emphasize based on user profile
   */
  private determineAlgorithm(totalRatings: number): 'collaborative' | 'content' | 'hybrid' {
    if (totalRatings < 5) {
      return 'content'; // New user, rely on content similarity
    } else if (totalRatings > 20) {
      return 'collaborative'; // Experienced user, rely on collaborative filtering
    } else {
      return 'hybrid'; // Balanced approach for intermediate users
    }
  }

  /**
   * Calculate engagement score from reading activity
   */
  private calculateEngagementScore(progress: number, timeSpent: number): number {
    // Base score from progress (0-1)
    let score = progress * 5;
    
    // Adjust based on time spent
    if (timeSpent > 120) score += 1; // 2+ hours shows deep engagement
    else if (timeSpent > 60) score += 0.5; // 1+ hour
    else if (timeSpent > 30) score += 0.3; // 30+ minutes
    else if (timeSpent < 10) score -= 0.5; // Quick skim
    
    return Math.max(1, Math.min(5, score));
  }

  /**
   * Get recommendation explanation for user interface
   */
  getRecommendationExplanation(recommendation: Recommendation): string {
    switch (recommendation.reason) {
      case 'collaborative':
        return `Users with similar reading preferences loved this item`;
      case 'content':
        return `Based on your interest in ${recommendation.item?.tags?.slice(0, 2).join(' and ')}`;
      case 'trending':
        return `Popular among readers this ${recommendation.confidence > 0.8 ? 'week' : 'month'}`;
      case 'new':
        return `Newly added content that might interest you`;
      default:
        return `Recommended based on your reading history`;
    }
  }

  /**
   * Get similarity explanation for collaborative filtering recommendations
   */
  getSimilarityExplanation(
    recommendation: Recommendation,
    userProfile: any
  ): string {
    if (recommendation.reason !== 'collaborative') {
      return '';
    }

    const commonInterests = userProfile.primaryInterests?.filter((interest: string) =>
      recommendation.item?.tags?.some(tag => 
        tag.toLowerCase().includes(interest.toLowerCase())
      )
    ) || [];

    if (commonInterests.length > 0) {
      return `Shares your interests in ${commonInterests.slice(0, 2).join(' and ')}`;
    }

    return `Similar readers (${Math.round(recommendation.confidence * 100)}% match) enjoyed this`;
  }

  /**
   * Track recommendation click-through for feedback
   */
  async trackRecommendationClick(userId: string, itemId: string, position: number) {
    try {
      // This could be used to improve future recommendations
      await prisma.userInteraction.create({
        data: {
          userId,
          itemId,
          type: 'recommendation_click',
          metadata: {
            position,
            timestamp: new Date(),
          },
        },
      });

      // Update recommendation confidence based on user engagement
      await this.updateRecommendationFeedback(userId, itemId, 'click');
    } catch (error) {
      console.error('Error tracking recommendation click:', error);
    }
  }

  /**
   * Update recommendation feedback for learning
   */
  private async updateRecommendationFeedback(
    userId: string,
    itemId: string,
    action: 'click' | 'read' | 'complete' | 'dismiss'
  ) {
    try {
      // Store feedback for future model improvements
      await prisma.userInteraction.create({
        data: {
          userId,
          itemId,
          type: `recommendation_${action}`,
          metadata: {
            timestamp: new Date(),
            algorithm: 'collaborative', // Track which algorithm recommended this
          },
        },
      });
    } catch (error) {
      console.error('Error updating recommendation feedback:', error);
    }
  }
}