import { z } from 'zod';
import { OpenAIClient } from './OpenAIClient';
import { prisma } from '../database/prisma';
import { redis } from '../database/redis';

// Types for summarization
export interface ContentSummary {
  id: string;
  itemId: string;
  summary: string;
  keyPoints: string[];
  readingTime: number; // minutes
  difficulty: 'beginner' | 'intermediate' | 'advanced';
  topics: string[];
  summaryType: 'brief' | 'detailed' | 'comprehensive';
  confidence: number;
  generatedAt: Date;
  metadata: {
    wordCount: number;
    model: string;
    processingTime: number;
    cost: number;
  };
}

export interface SummaryRequest {
  itemId: string;
  summaryType?: 'brief' | 'detailed' | 'comprehensive';
  targetLength?: number; // words
  includeKeyPoints?: boolean;
  includeTopics?: boolean;
  language?: string;
  outputFormat?: 'text' | 'bullet_points' | 'structured';
}

export interface GenerateSummaryInput {
  itemId: string;
  content?: string; // Optional content override
  summaryType?: 'brief' | 'detailed' | 'comprehensive';
  targetLength?: number;
  includeMetadata?: boolean;
  forceRegenerate?: boolean;
}

export interface GenerateSummaryOutput {
  summary: ContentSummary;
  cost: number;
  processingTime: number;
}

export interface BatchSummarizeInput {
  itemIds: string[];
  summaryType?: 'brief' | 'detailed' | 'comprehensive';
  priority?: 'high' | 'normal' | 'low';
  maxBatchSize?: number;
}

export interface BatchSummarizeOutput {
  successful: Array<{ itemId: string; summary: ContentSummary }>;
  failed: Array<{ itemId: string; error: string }>;
  totalProcessed: number;
  totalCost: number;
}

// Validation schemas
export const SummaryRequestSchema = z.object({
  itemId: z.string().uuid(),
  summaryType: z.enum(['brief', 'detailed', 'comprehensive']).default('detailed'),
  targetLength: z.number().min(50).max(1000).optional(),
  includeKeyPoints: z.boolean().default(true),
  includeTopics: z.boolean().default(true),
  language: z.string().default('en'),
  outputFormat: z.enum(['text', 'bullet_points', 'structured']).default('text'),
});

export const GenerateSummaryInputSchema = z.object({
  itemId: z.string().uuid(),
  content: z.string().optional(),
  summaryType: z.enum(['brief', 'detailed', 'comprehensive']).default('detailed'),
  targetLength: z.number().min(50).max(1000).optional(),
  includeMetadata: z.boolean().default(true),
  forceRegenerate: z.boolean().default(false),
});

export class AISummarizer {
  private aiClient: OpenAIClient;
  private readonly MAX_CONTENT_LENGTH = 8000; // characters
  private readonly SUMMARY_CACHE_TTL = 7 * 24 * 60 * 60; // 7 days in seconds
  private readonly COST_PER_SUMMARY = {
    brief: 0.002,
    detailed: 0.004,
    comprehensive: 0.008,
  };

  constructor() {
    this.aiClient = new OpenAIClient();
  }

  /**
   * Generate AI-powered summary for an item
   */
  async generateSummary(input: GenerateSummaryInput): Promise<GenerateSummaryOutput> {
    try {
      const startTime = Date.now();
      
      // Validate input
      const validatedInput = GenerateSummaryInputSchema.parse(input);

      // Check for existing summary (unless force regeneration is requested)
      if (!validatedInput.forceRegenerate) {
        const existingSummary = await this.getExistingSummary(validatedInput.itemId);
        if (existingSummary) {
          return {
            summary: existingSummary,
            cost: 0,
            processingTime: Date.now() - startTime,
          };
        }
      }

      // Get item content
      const item = await prisma.item.findUnique({
        where: { id: validatedInput.itemId },
        include: {
          aiGeneratedSummary: true, // Check if we already have a summary
          tags: true,
        },
      });

      if (!item) {
        throw new Error('Item not found');
      }

      // Determine content source
      const content = validatedInput.content || 
        item.content || 
        item.description || 
        '';

      if (!content || content.trim().length < 50) {
        throw new Error('Insufficient content for summarization');
      }

      // Truncate content if too long
      const processedContent = this.preprocessContent(content);

      // Generate summary using AI
      const aiResult = await this.generateAISummary(processedContent, validatedInput);

      // Create summary record
      const summary: ContentSummary = {
        id: `summary_${validatedInput.itemId}_${Date.now()}`,
        itemId: validatedInput.itemId,
        summary: aiResult.summary,
        keyPoints: aiResult.keyPoints,
        readingTime: this.estimateReadingTime(aiResult.summary),
        difficulty: this.assessDifficulty(content, aiResult),
        topics: this.extractTopics(item.tags?.map(t => t.name) || [], aiResult.keyPoints),
        summaryType: validatedInput.summaryType,
        confidence: aiResult.confidence,
        generatedAt: new Date(),
        metadata: {
          wordCount: aiResult.summary.split(' ').length,
          model: 'gpt-3.5-turbo',
          processingTime: Date.now() - startTime,
          cost: this.COST_PER_SUMMARY[validatedInput.summaryType],
        },
      };

      // Save summary to database
      await this.saveSummary(summary);

      // Cache summary for future requests
      await this.cacheSummary(summary);

      return {
        summary,
        cost: this.COST_PER_SUMMARY[validatedInput.summaryType],
        processingTime: Date.now() - startTime,
      };

    } catch (error) {
      console.error('Error generating summary:', error);
      throw error;
    }
  }

  /**
   * Batch generate summaries for multiple items
   */
  async batchSummarize(input: BatchSummarizeInput): Promise<BatchSummarizeOutput> {
    const results = {
      successful: [] as Array<{ itemId: string; summary: ContentSummary }>,
      failed: [] as Array<{ itemId: string; error: string }>,
      totalProcessed: 0,
      totalCost: 0,
    };

    const batchSize = input.maxBatchSize || 5;
    
    for (let i = 0; i < input.itemIds.length; i += batchSize) {
      const batch = input.itemIds.slice(i, i + batchSize);
      
      const batchPromises = batch.map(async (itemId) => {
        try {
          const result = await this.generateSummary({
            itemId,
            summaryType: input.summaryType,
          });
          
          results.successful.push({ itemId, summary: result.summary });
          results.totalCost += result.cost;
          return { itemId, success: true };

        } catch (error) {
          results.failed.push({ 
            itemId, 
            error: error instanceof Error ? error.message : 'Unknown error' 
          });
          return { itemId, success: false, error: error };
        }
      });

      const batchResults = await Promise.allSettled(batchPromises);
      results.totalProcessed += batch.length;

      // Small delay between batches to respect rate limits
      if (i + batchSize < input.itemIds.length) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    return results;
  }

  /**
   * Get existing summary for an item
   */
  private async getExistingSummary(itemId: string): Promise<ContentSummary | null> {
    try {
      // Check cache first
      const cacheKey = `summary:${itemId}`;
      const cached = await redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }

      // Check database
      const item = await prisma.item.findUnique({
        where: { id: itemId },
        select: {
          aiGeneratedSummary: true,
          embeddingProcessedAt: true,
          updatedAt: true,
        },
      });

      if (!item?.aiGeneratedSummary) {
        return null;
      }

      // Check if summary is recent enough (less than 30 days old)
      const summaryAge = Date.now() - item.updatedAt.getTime();
      const thirtyDays = 30 * 24 * 60 * 60 * 1000;
      
      if (summaryAge > thirtyDays) {
        return null; // Summary is too old, regenerate
      }

      const summary: ContentSummary = {
        id: `db_summary_${itemId}`,
        itemId,
        summary: item.aiGeneratedSummary,
        keyPoints: [], // Would need to extract from stored summary
        readingTime: this.estimateReadingTime(item.aiGeneratedSummary),
        difficulty: 'intermediate', // Default
        topics: [], // Would need to extract from tags
        summaryType: 'detailed',
        confidence: 0.8, // Default confidence for stored summaries
        generatedAt: item.updatedAt,
        metadata: {
          wordCount: item.aiGeneratedSummary.split(' ').length,
          model: 'cached',
          processingTime: 0,
          cost: 0,
        },
      };

      // Cache the summary
      await this.cacheSummary(summary);

      return summary;

    } catch (error) {
      console.error('Error getting existing summary:', error);
      return null;
    }
  }

  /**
   * Generate AI summary using OpenAI
   */
  private async generateAISummary(
    content: string,
    input: GenerateSummaryInput
  ): Promise<{
    summary: string;
    keyPoints: string[];
    confidence: number;
  }> {
    try {
      const summaryType = input.summaryType || 'detailed';
      const targetLength = input.targetLength || this.getTargetLength(summaryType);

      const prompt = this.buildSummaryPrompt(content, summaryType, targetLength);

      const response = await this.aiClient.generateText({
        model: 'gpt-3.5-turbo',
        prompt,
        maxTokens: targetLength * 2, // Allow some buffer
        temperature: 0.3, // Lower temperature for more consistent summaries
      });

      // Parse AI response
      const result = this.parseSummaryResponse(response, summaryType);

      // Validate and enhance summary
      const validatedSummary = this.validateAndEnhanceSummary(result.summary, content);
      const validatedKeyPoints = this.validateKeyPoints(result.keyPoints);

      return {
        summary: validatedSummary,
        keyPoints: validatedKeyPoints,
        confidence: result.confidence,
      };

    } catch (error) {
      console.error('Error generating AI summary:', error);
      
      // Fallback to simple extractive summary
      return this.generateFallbackSummary(content, input.summaryType || 'detailed');
    }
  }

  /**
   * Build prompt for AI summary generation
   */
  private buildSummaryPrompt(
    content: string,
    summaryType: 'brief' | 'detailed' | 'comprehensive',
    targetLength: number
  ): string {
    const typeInstructions = {
      brief: 'Create a concise 2-3 sentence summary that captures the main essence',
      detailed: 'Create a comprehensive paragraph summary that covers key concepts and insights',
      comprehensive: 'Create a detailed multi-paragraph summary that thoroughly explains the content',
    };

    return `
Please analyze the following content and create a high-quality summary.

Content:
${content}

Instructions:
- ${typeInstructions[summaryType]}
- Target length: approximately ${targetLength} words
- Use clear, accessible language
- Maintain the original meaning and key insights
- Focus on the most important information for readers

Format your response as JSON with the following structure:
{
  "summary": "Your detailed summary here",
  "keyPoints": ["Point 1", "Point 2", "Point 3"],
  "confidence": 0.9
}

Ensure the summary is accurate and comprehensive while being easy to understand.`;
  }

  /**
   * Parse AI response and extract structured data
   */
  private parseSummaryResponse(
    response: string,
    summaryType: 'brief' | 'detailed' | 'comprehensive'
  ): {
    summary: string;
    keyPoints: string[];
    confidence: number;
  } {
    try {
      // Try to parse as JSON first
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          summary: parsed.summary || this.extractSummaryText(response),
          keyPoints: parsed.keyPoints || this.extractKeyPoints(response),
          confidence: Math.max(0.5, Math.min(0.95, parsed.confidence || 0.8)),
        };
      }
    } catch (error) {
      console.warn('Failed to parse AI response as JSON, falling back to text extraction');
    }

    // Fallback to text parsing
    return {
      summary: this.extractSummaryText(response),
      keyPoints: this.extractKeyPoints(response),
      confidence: 0.7,
    };
  }

  /**
   * Extract summary text from AI response
   */
  private extractSummaryText(response: string): string {
    // Remove JSON artifacts and extract main text
    let text = response
      .replace(/\{[\s\S]*\}/g, '') // Remove JSON blocks
      .replace(/["'`]/g, '') // Remove quotes
      .trim();

    // If still too long, truncate at sentence boundary
    if (text.length > 500) {
      const sentences = text.split(/[.!?]+/);
      let truncated = '';
      for (const sentence of sentences) {
        if ((truncated + sentence).length > 450) break;
        truncated += sentence + '.';
      }
      text = truncated || text.substring(0, 450) + '...';
    }

    return text;
  }

  /**
   * Extract key points from AI response
   */
  private extractKeyPoints(response: string): string[] {
    const lines = response.split('\n');
    const points: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      
      // Look for bullet points or numbered lists
      if (
        trimmed.match(/^[-*•]/) || 
        trimmed.match(/^\d+\./) ||
        trimmed.startsWith('Point') ||
        trimmed.startsWith('Key')
      ) {
        const cleanPoint = trimmed
          .replace(/^[-*•\d+\.\s]*/, '')
          .replace(/^Point \d+:\s*/i, '')
          .replace(/^Key \d+:\s*/i, '')
          .trim();
        
        if (cleanPoint.length > 10) {
          points.push(cleanPoint);
        }
      }
    }

    // If no structured points found, try to extract from plain text
    if (points.length === 0) {
      const sentences = response.split(/[.!?]+/).filter(s => s.trim().length > 20);
      points.push(...sentences.slice(0, 3).map(s => s.trim()));
    }

    return points.slice(0, 5); // Limit to 5 key points
  }

  /**
   * Validate and enhance generated summary
   */
  private validateAndEnhanceSummary(summary: string, originalContent: string): string {
    // Basic validation
    if (!summary || summary.length < 50) {
      throw new Error('Generated summary is too short');
    }

    // Ensure summary is coherent and well-formed
    const sentences = summary.split(/[.!?]+/).filter(s => s.trim().length > 10);
    if (sentences.length < 1) {
      throw new Error('Generated summary lacks proper sentence structure');
    }

    return summary.trim();
  }

  /**
   * Validate extracted key points
   */
  private validateKeyPoints(keyPoints: string[]): string[] {
    return keyPoints
      .filter(point => point && point.trim().length > 10)
      .map(point => point.trim())
      .slice(0, 5); // Limit to 5 points
  }

  /**
   * Generate fallback summary using simple extractive approach
   */
  private generateFallbackSummary(
    content: string,
    summaryType: 'brief' | 'detailed' | 'comprehensive'
  ): {
    summary: string;
    keyPoints: string[];
    confidence: number;
  } {
    const sentences = content.split(/[.!?]+/).filter(s => s.trim().length > 20);
    
    // Select sentences based on summary type
    let sentenceCount = 1;
    if (summaryType === 'detailed') sentenceCount = 2;
    if (summaryType === 'comprehensive') sentenceCount = 3;

    const selectedSentences = sentences.slice(0, sentenceCount);
    const summary = selectedSentences.join('. ').trim() + '.';

    // Extract key points as the first few sentences
    const keyPoints = sentences.slice(0, 3).map(s => s.trim());

    return {
      summary,
      keyPoints,
      confidence: 0.6, // Lower confidence for fallback
    };
  }

  /**
   * Preprocess content before summarization
   */
  private preprocessContent(content: string): string {
    // Remove extra whitespace and normalize
    let processed = content
      .replace(/\s+/g, ' ')
      .trim();

    // Remove very short sentences that don't add value
    const sentences = processed.split(/[.!?]+/);
    const meaningfulSentences = sentences.filter(s => s.trim().length > 10);
    
    processed = meaningfulSentences.join('. ').trim();

    // Truncate if too long
    if (processed.length > this.MAX_CONTENT_LENGTH) {
      processed = processed.substring(0, this.MAX_CONTENT_LENGTH) + '...';
    }

    return processed;
  }

  /**
   * Get target word count based on summary type
   */
  private getTargetLength(summaryType: 'brief' | 'detailed' | 'comprehensive'): number {
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
   * Estimate reading time in minutes
   */
  private estimateReadingTime(text: string): number {
    const wordsPerMinute = 200; // Average reading speed
    const wordCount = text.split(/\s+/).length;
    return Math.max(1, Math.ceil(wordCount / wordsPerMinute));
  }

  /**
   * Assess content difficulty level
   */
  private assessDifficulty(content: string, aiResult: any): 'beginner' | 'intermediate' | 'advanced' {
    // Simple heuristic based on word complexity
    const words = content.toLowerCase().split(/\s+/);
    const longWords = words.filter(word => word.length > 8).length;
    const complexRatio = longWords / words.length;

    // Check for technical terms in key points
    const technicalTerms = ['algorithm', 'methodology', 'analysis', 'research', 'system', 'framework'];
    const hasTechnicalTerms = aiResult.keyPoints.some((point: string) =>
      technicalTerms.some(term => point.toLowerCase().includes(term))
    );

    if (complexRatio > 0.15 || hasTechnicalTerms) {
      return 'advanced';
    } else if (complexRatio > 0.08) {
      return 'intermediate';
    } else {
      return 'beginner';
    }
  }

  /**
   * Extract topics from tags and key points
   */
  private extractTopics(existingTags: string[], keyPoints: string[]): string[] {
    const topics = new Set<string>();

    // Add existing tags
    existingTags.forEach(tag => topics.add(tag));

    // Extract topics from key points
    const topicKeywords = [
      'artificial intelligence', 'machine learning', 'data science', 'technology',
      'business', 'management', 'leadership', 'strategy', 'innovation',
      'science', 'research', 'development', 'analysis', 'methodology',
      'psychology', 'behavior', 'learning', 'education', 'training',
      'health', 'wellness', 'fitness', 'nutrition', 'medicine'
    ];

    keyPoints.forEach(point => {
      const pointLower = point.toLowerCase();
      topicKeywords.forEach(keyword => {
        if (pointLower.includes(keyword)) {
          topics.add(keyword);
        }
      });
    });

    return Array.from(topics).slice(0, 5); // Limit to 5 topics
  }

  /**
   * Save summary to database
   */
  private async saveSummary(summary: ContentSummary): Promise<void> {
    try {
      // Update item with AI-generated summary
      await prisma.item.update({
        where: { id: summary.itemId },
        data: {
          aiGeneratedSummary: summary.summary,
          updatedAt: new Date(),
        },
      });
    } catch (error) {
      console.error('Error saving summary to database:', error);
      // Don't throw error - summary is still cached
    }
  }

  /**
   * Cache summary for future requests
   */
  private async cacheSummary(summary: ContentSummary): Promise<void> {
    try {
      const cacheKey = `summary:${summary.itemId}`;
      await redis.setex(cacheKey, this.SUMMARY_CACHE_TTL, JSON.stringify(summary));
    } catch (error) {
      console.error('Error caching summary:', error);
      // Don't throw error - operation should continue
    }
  }

  /**
   * Get summary by item ID
   */
  async getSummary(itemId: string): Promise<ContentSummary | null> {
    try {
      // Check cache first
      const cacheKey = `summary:${itemId}`;
      const cached = await redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }

      // Check database
      const item = await prisma.item.findUnique({
        where: { id: itemId },
        select: { aiGeneratedSummary: true },
      });

      if (item?.aiGeneratedSummary) {
        const summary: ContentSummary = {
          id: `db_summary_${itemId}`,
          itemId,
          summary: item.aiGeneratedSummary,
          keyPoints: [],
          readingTime: this.estimateReadingTime(item.aiGeneratedSummary),
          difficulty: 'intermediate',
          topics: [],
          summaryType: 'detailed',
          confidence: 0.8,
          generatedAt: new Date(),
          metadata: {
            wordCount: item.aiGeneratedSummary.split(' ').length,
            model: 'cached',
            processingTime: 0,
            cost: 0,
          },
        };

        // Cache it
        await this.cacheSummary(summary);
        return summary;
      }

      return null;
    } catch (error) {
      console.error('Error getting summary:', error);
      return null;
    }
  }

  /**
   * Get cost estimate for summary generation
   */
  getCostEstimate(summaryType: 'brief' | 'detailed' | 'comprehensive'): number {
    return this.COST_PER_SUMMARY[summaryType];
  }

  /**
   * Check if content is suitable for summarization
   */
  isContentSuitable(content: string): { suitable: boolean; reason?: string } {
    if (!content || content.trim().length < 50) {
      return { suitable: false, reason: 'Content too short for summarization' };
    }

    if (content.length > this.MAX_CONTENT_LENGTH) {
      return { suitable: false, reason: 'Content too long for summarization' };
    }

    // Check for meaningful sentences
    const sentences = content.split(/[.!?]+/).filter(s => s.trim().length > 10);
    if (sentences.length < 1) {
      return { suitable: false, reason: 'Content lacks meaningful sentences' };
    }

    return { suitable: true };
  }
}