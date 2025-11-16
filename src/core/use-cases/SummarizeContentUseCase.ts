import { z } from 'zod';
import { AISummarizer, SummaryRequest } from '../../infrastructure/ai/AISummarizer';
import { AppError } from '../../shared/errors/AppError';

export interface SummarizeContentInput {
  itemId: string;
  summaryType?: 'brief' | 'detailed' | 'comprehensive';
  targetLength?: number;
  includeMetadata?: boolean;
  customContent?: string;
}

export interface SummarizeContentOutput {
  summary: {
    text: string;
    keyPoints: string[];
    readingTime: number;
    difficulty: 'beginner' | 'intermediate' | 'advanced';
    topics: string[];
  };
  metadata: {
    summaryType: string;
    wordCount: number;
    confidence: number;
    generatedAt: string;
    processingTime: number;
  };
  cost: number;
}

export interface BatchSummarizeContentInput {
  itemIds: string[];
  summaryType?: 'brief' | 'detailed' | 'comprehensive';
  priority?: 'high' | 'normal' | 'low';
  onProgress?: (progress: { completed: number; total: number; currentItemId?: string }) => void;
}

export interface BatchSummarizeContentOutput {
  successful: Array<{
    itemId: string;
    summary: {
      text: string;
      keyPoints: string[];
      readingTime: number;
      difficulty: string;
      topics: string[];
    };
  }>;
  failed: Array<{
    itemId: string;
    error: string;
  }>;
  totalProcessed: number;
  totalCost: number;
  summary: {
    totalSuccessful: number;
    totalFailed: number;
    averageProcessingTime: number;
  };
}

// Validation schemas
export const SummarizeContentInputSchema = z.object({
  itemId: z.string().uuid(),
  summaryType: z.enum(['brief', 'detailed', 'comprehensive']).default('detailed'),
  targetLength: z.number().min(50).max(1000).optional(),
  includeMetadata: z.boolean().default(true),
  customContent: z.string().optional(),
});

export const BatchSummarizeContentInputSchema = z.object({
  itemIds: z.array(z.string().uuid()).min(1).max(50),
  summaryType: z.enum(['brief', 'detailed', 'comprehensive']).default('detailed'),
  priority: z.enum(['high', 'normal', 'low']).default('normal'),
});

export class SummarizeContentUseCase {
  private aiSummarizer: AISummarizer;

  constructor() {
    this.aiSummarizer = new AISummarizer();
  }

  async execute(input: SummarizeContentInput): Promise<SummarizeContentOutput> {
    try {
      // Validate input
      const validatedInput = SummarizeContentInputSchema.parse(input);

      // Check if content is suitable for summarization
      const item = await this.getItemContent(validatedInput.itemId, validatedInput.customContent);
      const suitability = this.aiSummarizer.isContentSuitable(item.content);

      if (!suitability.suitable) {
        throw new AppError('CONTENT_NOT_SUITABLE', suitability.reason || 'Content cannot be summarized');
      }

      // Generate summary
      const result = await this.aiSummarizer.generateSummary({
        itemId: validatedInput.itemId,
        content: validatedInput.customContent,
        summaryType: validatedInput.summaryType,
        targetLength: validatedInput.targetLength,
      });

      // Format output
      return {
        summary: {
          text: result.summary.summary,
          keyPoints: result.summary.keyPoints,
          readingTime: result.summary.readingTime,
          difficulty: result.summary.difficulty,
          topics: result.summary.topics,
        },
        metadata: {
          summaryType: result.summary.summaryType,
          wordCount: result.summary.metadata.wordCount,
          confidence: result.summary.confidence,
          generatedAt: result.summary.generatedAt.toISOString(),
          processingTime: result.summary.metadata.processingTime,
        },
        cost: result.cost,
      };

    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      console.error('Error in SummarizeContentUseCase:', error);
      throw new AppError('SUMMARIZATION_FAILED', 'Failed to generate content summary');
    }
  }

  /**
   * Batch summarize multiple items
   */
  async executeBatch(input: BatchSummarizeContentInput): Promise<BatchSummarizeContentOutput> {
    try {
      // Validate input
      const validatedInput = BatchSummarizeContentInputSchema.parse(input);

      const results = {
        successful: [] as Array<any>,
        failed: [] as Array<any>,
        totalProcessed: 0,
        totalCost: 0,
        totalProcessingTime: 0,
      };

      const totalItems = validatedInput.itemIds.length;
      let processed = 0;

      // Process items in smaller batches to manage resources
      const batchSize = Math.min(3, Math.max(1, Math.floor(50 / validatedInput.itemIds.length)));

      for (let i = 0; i < validatedInput.itemIds.length; i += batchSize) {
        const batch = validatedInput.itemIds.slice(i, i + batchSize);
        
        const batchPromises = batch.map(async (itemId) => {
          try {
            const result = await this.aiSummarizer.generateSummary({
              itemId,
              summaryType: validatedInput.summaryType,
            });

            processed++;
            
            // Report progress if callback provided
            if (input.onProgress) {
              input.onProgress({
                completed: processed,
                total: totalItems,
                currentItemId: itemId,
              });
            }

            return {
              itemId,
              success: true,
              summary: {
                text: result.summary.summary,
                keyPoints: result.summary.keyPoints,
                readingTime: result.summary.readingTime,
                difficulty: result.summary.difficulty,
                topics: result.summary.topics,
              },
              cost: result.cost,
              processingTime: result.processingTime,
            };

          } catch (error) {
            processed++;
            
            // Report progress even for failures
            if (input.onProgress) {
              input.onProgress({
                completed: processed,
                total: totalItems,
                currentItemId: itemId,
              });
            }

            return {
              itemId,
              success: false,
              error: error instanceof Error ? error.message : 'Unknown error',
            };
          }
        });

        const batchResults = await Promise.allSettled(batchPromises);

        // Process results
        for (const result of batchResults) {
          if (result.status === 'fulfilled') {
            const { itemId, success, ...data } = result.value;
            
            if (success) {
              results.successful.push({ itemId, ...data });
              results.totalCost += data.cost;
              results.totalProcessingTime += data.processingTime;
            } else {
              results.failed.push({ itemId, error: data.error });
            }
            
            results.totalProcessed++;
          } else {
            // Promise was rejected
            results.failed.push({
              itemId: 'unknown',
              error: 'Batch processing error',
            });
          }
        }

        // Small delay between batches to respect rate limits
        if (i + batchSize < validatedInput.itemIds.length) {
          await new Promise(resolve => setTimeout(resolve, 3000));
        }
      }

      return {
        successful: results.successful,
        failed: results.failed,
        totalProcessed: results.totalProcessed,
        totalCost: results.totalCost,
        summary: {
          totalSuccessful: results.successful.length,
          totalFailed: results.failed.length,
          averageProcessingTime: results.totalProcessed > 0 
            ? Math.round(results.totalProcessingTime / results.totalProcessed)
            : 0,
        },
      };

    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      console.error('Error in batch summarization:', error);
      throw new AppError('BATCH_SUMMARIZATION_FAILED', 'Failed to process batch summarization');
    }
  }

  /**
   * Get item content from database
   */
  private async getItemContent(itemId: string, customContent?: string): Promise<{ content: string }> {
    if (customContent) {
      return { content: customContent };
    }

    const item = await prisma.item.findUnique({
      where: { id: itemId },
      select: {
        content: true,
        description: true,
        url: true,
        title: true,
      },
    });

    if (!item) {
      throw new AppError('ITEM_NOT_FOUND', `Item with ID ${itemId} not found`);
    }

    const content = item.content || item.description || '';
    
    if (!content || content.trim().length < 50) {
      throw new AppError('INSUFFICIENT_CONTENT', 'Item does not have sufficient content for summarization');
    }

    return { content };
  }

  /**
   * Get summary quality metrics
   */
  getSummaryMetrics(summary: any): {
    completeness: number;
    readability: number;
    coherence: number;
    overallQuality: number;
  } {
    // Calculate completeness based on key points coverage
    const completeness = Math.min(1, summary.keyPoints.length / 3);

    // Estimate readability based on average sentence length
    const sentences = summary.text.split(/[.!?]+/).filter(s => s.trim().length > 0);
    const avgSentenceLength = sentences.length > 0 
      ? summary.text.split(' ').length / sentences.length 
      : 0;
    const readability = Math.max(0, Math.min(1, (20 - Math.abs(avgSentenceLength - 15)) / 20));

    // Estimate coherence based on summary length relative to target
    const targetLength = this.getTargetLength(summary.summaryType);
    const lengthRatio = summary.metadata.wordCount / targetLength;
    const coherence = Math.max(0.5, Math.min(1, 1 - Math.abs(lengthRatio - 1)));

    // Overall quality is weighted average
    const overallQuality = (completeness * 0.4) + (readability * 0.3) + (coherence * 0.3);

    return {
      completeness: Math.round(completeness * 100) / 100,
      readability: Math.round(readability * 100) / 100,
      coherence: Math.round(coherence * 100) / 100,
      overallQuality: Math.round(overallQuality * 100) / 100,
    };
  }

  /**
   * Get target length for summary type
   */
  private getTargetLength(summaryType: string): number {
    switch (summaryType) {
      case 'brief':
        return 50;
      case 'detailed':
        return 150;
      case 'comprehensive':
        return 300;
      default:
        return 150;
    }
  }

  /**
   * Get summary format suggestions
   */
  getFormatSuggestions(contentLength: number, purpose: string): {
    suggestedType: 'brief' | 'detailed' | 'comprehensive';
    rationale: string;
    alternatives: Array<{ type: string; reason: string }>;
  } {
    let suggestedType: 'brief' | 'detailed' | 'comprehensive' = 'detailed';
    let rationale = '';

    // Suggest based on content length
    if (contentLength < 1000) {
      suggestedType = 'brief';
      rationale = 'Short content is best summarized concisely';
    } else if (contentLength > 5000) {
      suggestedType = 'comprehensive';
      rationale = 'Long content requires detailed coverage';
    } else {
      rationale = 'Medium-length content benefits from balanced detail';
    }

    // Adjust based on purpose
    const alternatives = [];
    
    if (purpose === 'quick_overview') {
      alternatives.push({ type: 'brief', reason: 'Fast overview for time-constrained readers' });
    } else if (purpose === 'research' || purpose === 'study') {
      alternatives.push({ type: 'comprehensive', reason: 'In-depth coverage for learning purposes' });
      suggestedType = 'comprehensive';
      rationale = 'Educational content requires comprehensive treatment';
    } else if (purpose === 'share' || purpose === 'social') {
      alternatives.push({ type: 'brief', reason: 'Easy to share and digest' });
    }

    return {
      suggestedType,
      rationale,
      alternatives,
    };
  }

  /**
   * Enhance summary with additional context
   */
  enhanceSummary(summary: any, itemMetadata: any): any {
    // Add context-specific enhancements
    const enhanced = { ...summary };

    // Add source credibility if available
    if (itemMetadata.source) {
      enhanced.sourceCredibility = this.assessSourceCredibility(itemMetadata.source);
    }

    // Add relevance scoring based on user's reading history
    if (itemMetadata.userReadingHistory) {
      enhanced.relevanceScore = this.calculateRelevanceScore(summary, itemMetadata.userReadingHistory);
    }

    // Add reading difficulty adjustment
    if (enhanced.difficulty === 'advanced' && summary.readingTime < 5) {
      enhanced.readingRecommendation = 'Consider taking notes while reading for better comprehension';
    } else if (enhanced.difficulty === 'beginner' && summary.readingTime > 15) {
      enhanced.readingRecommendation = 'Take breaks to avoid information overload';
    }

    return enhanced;
  }

  /**
   * Assess source credibility
   */
  private assessSourceCredibility(source: string): {
    score: number;
    level: 'high' | 'medium' | 'low';
    indicators: string[];
  } {
    const indicators = [];
    let score = 0.5; // Default medium credibility

    // Check for academic sources
    if (source.includes('.edu') || source.includes('research') || source.includes('journal')) {
      score += 0.3;
      indicators.push('Academic or research source');
    }

    // Check for well-known publications
    const reputableSources = ['reuters', 'bbc', 'mit technology review', 'nature', 'science'];
    if (reputableDomains.some(domain => source.toLowerCase().includes(domain))) {
      score += 0.2;
      indicators.push('Reputable publication');
    }

    // Check for author credentials
    if (source.includes('expert') || source.includes('professor') || source.includes('phd')) {
      score += 0.2;
      indicators.push('Expert author credentials');
    }

    score = Math.min(1, Math.max(0, score));

    return {
      score,
      level: score > 0.7 ? 'high' : score > 0.4 ? 'medium' : 'low',
      indicators,
    };
  }

  /**
   * Calculate relevance score based on user reading history
   */
  private calculateRelevanceScore(summary: any, readingHistory: any[]): number {
    // Simple relevance calculation based on topic overlap
    const summaryTopics = new Set(summary.topics.map((t: string) => t.toLowerCase()));
    
    let totalOverlap = 0;
    let totalHistory = 0;

    for (const history of readingHistory.slice(0, 20)) { // Check last 20 items
      const historyTopics = new Set(history.topics.map((t: string) => t.toLowerCase()));
      const overlap = [...summaryTopics].filter(topic => historyTopics.has(topic)).length;
      totalOverlap += overlap;
      totalHistory += historyTopics.size;
    }

    return totalHistory > 0 ? totalOverlap / totalHistory : 0;
  }

  /**
   * Generate summary preview for UI
   */
  generatePreview(summary: any, maxLength: number = 150): {
    preview: string;
    truncated: boolean;
    readMoreText: string;
  } {
    const text = summary.text;
    
    if (text.length <= maxLength) {
      return {
        preview: text,
        truncated: false,
        readMoreText: '',
      };
    }

    // Find a good breaking point
    const truncated = text.substring(0, maxLength);
    const lastSpace = truncated.lastIndexOf(' ');
    const preview = lastSpace > maxLength * 0.8 
      ? truncated.substring(0, lastSpace)
      : truncated;

    return {
      preview: preview + '...',
      truncated: true,
      readMoreText: 'Read full summary',
    };
  }
}

// Add the missing import for prisma
import { prisma } from '../../infrastructure/database/prisma';

// Add reputable domains list
const reputableDomains = [
  'mit.edu', 'stanford.edu', 'harvard.edu', 'reuters.com', 'bbc.com', 
  'nature.com', 'science.org', 'technologyreview.com', 'wired.com',
  'theguardian.com', 'npr.org', 'pbs.org'
];