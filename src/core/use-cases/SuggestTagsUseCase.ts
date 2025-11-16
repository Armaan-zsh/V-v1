import { AutoTaggingService } from '../../infrastructure/ai/AutoTaggingService';
import { IItemRepository } from '../../core/repositories/IItemRepository';
import { Result } from '../../shared/types/result';
import { DomainError, ValidationError, NotFoundError } from '../../shared/types/errors';

export interface TagSuggestion {
  name: string;
  slug: string;
  confidence: number;
  source: 'ai' | 'keyword' | 'manual';
}

export interface SuggestTagsInput {
  itemId: string;
  // Optional override content (useful for manual triggers)
  title?: string;
  author?: string;
  url?: string;
  notes?: string;
  type?: 'book' | 'paper' | 'article';
}

export interface SuggestTagsResult {
  suggestions: TagSuggestion[];
  processingTime: number;
  cost: number;
  itemId: string;
}

export class SuggestTagsUseCase {
  constructor(
    private readonly itemRepository: IItemRepository,
    private readonly autoTaggingService: AutoTaggingService
  ) {}

  async execute(input: SuggestTagsInput): Promise<Result<SuggestTagsResult, DomainError>> {
    try {
      // Validate input
      const validationResult = this.validateInput(input);
      if (!validationResult.success) {
        return validationResult;
      }

      // Get item from repository (either from input or by ID)
      const item = await this.getItemForTagging(input);
      if (!item) {
        return Result.err(new NotFoundError(`Item ${input.itemId} not found`));
      }

      // Get tag suggestions from AI service
      const suggestions = await this.autoTaggingService.suggestTags({
        itemId: item.id,
        title: input.title || item.title,
        author: input.author || item.author || undefined,
        url: input.url || item.url || undefined,
        notes: input.notes || item.notes || undefined,
        type: input.type || item.type,
      });

      // Log the tagging attempt
      await this.logTaggingAttempt(item.id, suggestions);

      const result: SuggestTagsResult = {
        suggestions: suggestions.tags,
        processingTime: suggestions.processingTime,
        cost: suggestions.cost,
        itemId: item.id,
      };

      return Result.ok(result);
    } catch (error) {
      console.error('SuggestTagsUseCase failed:', error);
      
      if (error instanceof DomainError) {
        return Result.err(error);
      }

      return Result.err(
        new DomainError('TAG_SUGGESTION_ERROR', 'Failed to suggest tags', { error })
      );
    }
  }

  async provideFeedback(
    itemId: string,
    suggestions: Array<{ tagSlug: string; accepted: boolean }>
  ): Promise<Result<void, DomainError>> {
    try {
      // Validate feedback
      if (!itemId || !suggestions || suggestions.length === 0) {
        return Result.err(new ValidationError('Invalid feedback data', 'feedback'));
      }

      // Provide feedback to AI service
      await this.autoTaggingService.provideFeedback(itemId, suggestions);

      // Log the feedback
      await this.logFeedback(itemId, suggestions);

      return Result.ok(undefined);
    } catch (error) {
      console.error('Feedback submission failed:', error);
      return Result.err(
        new DomainError('FEEDBACK_ERROR', 'Failed to submit feedback', { error })
      );
    }
  }

  async getTagStatistics(): Promise<Result<{
    totalSuggestions: number;
    acceptanceRate: number;
    topTags: Array<{ slug: string; name: string; count: number }>;
    averageConfidence: number;
    processingTimeStats: {
      average: number;
      p95: number;
    };
  }, DomainError>> {
    try {
      const stats = await this.autoTaggingService.getTagStats();
      return Result.ok({
        totalSuggestions: stats.totalSuggestions,
        acceptanceRate: stats.acceptanceRate,
        topTags: stats.topTags,
        averageConfidence: 0.8, // This would come from actual metrics
        processingTimeStats: {
          average: 150, // ms
          p95: 300, // ms
        },
      });
    } catch (error) {
      console.error('Failed to get tag statistics:', error);
      return Result.err(
        new DomainError('STATS_ERROR', 'Failed to get tag statistics', { error })
      );
    }
  }

  async getHealthStatus(): Promise<Result<{
    healthy: boolean;
    lastError: string | null;
    totalProcessed: number;
    averageConfidence: number;
    autoTaggingEnabled: boolean;
  }, DomainError>> {
    try {
      const healthStatus = await this.autoTaggingService.getHealthStatus();
      return Result.ok({
        healthy: healthStatus.healthy,
        lastError: healthStatus.lastError,
        totalProcessed: healthStatus.totalProcessed,
        averageConfidence: healthStatus.averageConfidence,
        autoTaggingEnabled: true,
      });
    } catch (error) {
      console.error('Health check failed:', error);
      return Result.err(
        new DomainError('HEALTH_CHECK_ERROR', 'Health check failed', { error })
      );
    }
  }

  // Bulk tag suggestion for multiple items
  async suggestTagsBulk(
    items: Array<{
      id: string;
      title: string;
      author?: string;
      url?: string;
      notes?: string;
      type: 'book' | 'paper' | 'article';
    }>
  ): Promise<Result<Array<{
    itemId: string;
    suggestions: TagSuggestion[];
    success: boolean;
    error?: string;
  }>, DomainError>> {
    try {
      const results = [];

      // Process items in batches to avoid overwhelming the AI service
      const batchSize = 5;
      for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        
        const batchPromises = batch.map(async (item) => {
          try {
            const suggestions = await this.autoTaggingService.suggestTags({
              itemId: item.id,
              title: item.title,
              author: item.author,
              url: item.url,
              notes: item.notes,
              type: item.type,
            });

            return {
              itemId: item.id,
              suggestions: suggestions.tags,
              success: true,
            };
          } catch (error) {
            console.error(`Failed to get suggestions for item ${item.id}:`, error);
            return {
              itemId: item.id,
              suggestions: [],
              success: false,
              error: error instanceof Error ? error.message : 'Unknown error',
            };
          }
        });

        const batchResults = await Promise.all(batchPromises);
        results.push(...batchResults);

        // Small delay between batches to respect rate limits
        if (i + batchSize < items.length) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }

      return Result.ok(results);
    } catch (error) {
      console.error('Bulk tag suggestion failed:', error);
      return Result.err(
        new DomainError('BULK_SUGGESTION_ERROR', 'Bulk suggestion failed', { error })
      );
    }
  }

  private validateInput(input: SuggestTagsInput): Result<void, ValidationError> {
    if (!input.itemId || input.itemId.trim().length === 0) {
      return Result.err(new ValidationError('Item ID is required', 'itemId'));
    }

    if (input.itemId.length > 50) {
      return Result.err(new ValidationError('Item ID too long', 'itemId'));
    }

    return Result.ok(undefined);
  }

  private async getItemForTagging(
    input: SuggestTagsInput
  ): Promise<any | null> {
    // If all required fields are provided in input, we can skip database lookup
    if (input.title && input.type) {
      return {
        id: input.itemId,
        title: input.title,
        author: input.author || null,
        url: input.url || null,
        notes: input.notes || null,
        type: input.type,
      };
    }

    // Otherwise, fetch from database
    return await this.itemRepository.findById(input.itemId);
  }

  private async logTaggingAttempt(
    itemId: string,
    suggestions: any
  ): Promise<void> {
    try {
      // Log to audit trail
      // This would be implemented with actual audit logging
      console.log(`Tagging attempt for item ${itemId}: ${suggestions.tags.length} suggestions`);
    } catch (error) {
      console.error('Failed to log tagging attempt:', error);
    }
  }

  private async logFeedback(
    itemId: string,
    suggestions: Array<{ tagSlug: string; accepted: boolean }>
  ): Promise<void> {
    try {
      const acceptedCount = suggestions.filter(s => s.accepted).length;
      const totalCount = suggestions.length;
      const acceptanceRate = totalCount > 0 ? acceptedCount / totalCount : 0;

      console.log(
        `Feedback for item ${itemId}: ${acceptedCount}/${totalCount} tags accepted (${(acceptanceRate * 100).toFixed(1)}%)`
      );
    } catch (error) {
      console.error('Failed to log feedback:', error);
    }
  }

  // Cleanup old cache entries
  async cleanupCache(): Promise<Result<number, DomainError>> {
    try {
      // This would implement cache cleanup logic
      // For now, just return 0
      return Result.ok(0);
    } catch (error) {
      console.error('Cache cleanup failed:', error);
      return Result.err(
        new DomainError('CLEANUP_ERROR', 'Cache cleanup failed', { error })
      );
    }
  }
}