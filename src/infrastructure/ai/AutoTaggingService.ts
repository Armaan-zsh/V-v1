import { OpenAI } from 'openai';
import { env } from '../../shared/config/env';
import { tagTaxonomy, Tag, findTagsByKeyword } from '../../shared/data/tag-taxonomy.json';
import { redis } from '../../database/redis';
import { prisma } from '../../database/prisma';

export interface AutoTagResult {
  tags: Array<{
    name: string;
    slug: string;
    confidence: number;
    source: 'ai' | 'keyword' | 'manual';
  }>;
  processingTime: number;
  cost: number;
}

export interface AutoTagRequest {
  itemId: string;
  title: string;
  author?: string;
  url?: string;
  notes?: string;
  type: 'book' | 'paper' | 'article';
}

export class AutoTaggingService {
  private static instance: AutoTaggingService | null = null;
  private openai: OpenAI;
  private readonly CONFIDENCE_THRESHOLD = 0.7;
  private readonly MAX_SUGGESTIONS = 3;
  private readonly CACHE_TTL = 30 * 24 * 60 * 60; // 30 days

  private constructor() {
    this.openai = new OpenAI({
      apiKey: env.OPENAI_API_KEY,
    });
  }

  static getInstance(): AutoTaggingService {
    if (!this.instance) {
      this.instance = new AutoTaggingService();
    }
    return this.instance;
  }

  async suggestTags(request: AutoTagRequest): Promise<AutoTagResult> {
    const startTime = Date.now();
    const cacheKey = this.generateCacheKey(request);

    try {
      // Check cache first
      const cached = await this.getCachedTags(cacheKey);
      if (cached) {
        return {
          ...cached,
          processingTime: Date.now() - startTime,
        };
      }

      // Extract text content from item
      const content = this.extractContent(request);

      // Try keyword matching first (fast and free)
      const keywordTags = this.performKeywordMatching(content);
      
      // If we have enough confident keyword matches, return early
      if (keywordTags.length >= this.MAX_SUGGESTIONS) {
        const result = {
          tags: keywordTags.slice(0, this.MAX_SUGGESTIONS),
          processingTime: Date.now() - startTime,
          cost: 0,
        };
        
        await this.cacheTags(cacheKey, result);
        return result;
      }

      // Fall back to AI classification
      const aiTags = await this.performAIClassification(content, request.type);
      
      // Combine and deduplicate results
      const combinedTags = this.combineTagResults(keywordTags, aiTags);
      
      // Sort by confidence and take top results
      const finalTags = combinedTags
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, this.MAX_SUGGESTIONS);

      const result = {
        tags: finalTags,
        processingTime: Date.now() - startTime,
        cost: aiTags.length > 0 ? 0.001 : 0, // Estimated cost
      };

      // Cache results
      await this.cacheTags(cacheKey, result);

      return result;
    } catch (error) {
      console.error('Auto-tagging failed:', error);
      
      // Fallback to keyword matching on error
      const content = this.extractContent(request);
      const fallbackTags = this.performKeywordMatching(content);
      
      return {
        tags: fallbackTags.slice(0, this.MAX_SUGGESTIONS).map(tag => ({
          ...tag,
          source: 'keyword' as const,
        })),
        processingTime: Date.now() - startTime,
        cost: 0,
      };
    }
  }

  async provideFeedback(
    itemId: string,
    suggestions: Array<{ tagSlug: string; accepted: boolean }>
  ): Promise<void> {
    try {
      // Store feedback for future improvement
      for (const feedback of suggestions) {
        await this.storeFeedback(itemId, feedback.tagSlug, feedback.accepted);
      }

      // Trigger model retraining if enough feedback collected (future feature)
      const totalFeedback = await this.getTotalFeedbackCount();
      if (totalFeedback >= 1000) {
        // In a real implementation, this would trigger a retraining job
        console.log('Sufficient feedback collected for model retraining');
      }
    } catch (error) {
      console.error('Failed to store feedback:', error);
    }
  }

  private extractContent(request: AutoTagRequest): string {
    const parts = [
      request.title,
      request.author,
      request.url,
      request.notes,
    ].filter(Boolean);

    return parts.join(' ');
  }

  private performKeywordMatching(content: string): Array<{
    name: string;
    slug: string;
    confidence: number;
    source: 'keyword';
  }> {
    const tags: Array<{
      name: string;
      slug: string;
      confidence: number;
      source: 'keyword';
    }> = [];

    const normalizedContent = content.toLowerCase();
    
    for (const category of tagTaxonomy.categories) {
      for (const tag of category.tags) {
        // Check tag name
        if (normalizedContent.includes(tag.name.toLowerCase())) {
          tags.push({
            name: tag.name,
            slug: tag.slug,
            confidence: 0.9,
            source: 'keyword',
          });
          continue;
        }

        // Check synonyms
        for (const synonym of tag.synonyms) {
          if (normalizedContent.includes(synonym.toLowerCase())) {
            tags.push({
              name: tag.name,
              slug: tag.slug,
              confidence: 0.8,
              source: 'keyword',
            });
            break;
          }
        }

        // Check examples
        for (const example of tag.examples) {
          if (normalizedContent.includes(example.toLowerCase())) {
            tags.push({
              name: tag.name,
              slug: tag.slug,
              confidence: 0.7,
              source: 'keyword',
            });
            break;
          }
        }
      }
    }

    // Deduplicate by slug and keep highest confidence
    const uniqueTags = new Map<string, {
      name: string;
      slug: string;
      confidence: number;
      source: 'keyword';
    }>();

    for (const tag of tags) {
      const existing = uniqueTags.get(tag.slug);
      if (!existing || tag.confidence > existing.confidence) {
        uniqueTags.set(tag.slug, tag);
      }
    }

    return Array.from(uniqueTags.values())
      .filter(tag => tag.confidence >= this.CONFIDENCE_THRESHOLD)
      .sort((a, b) => b.confidence - a.confidence);
  }

  private async performAIClassification(
    content: string,
    itemType: string
  ): Promise<Array<{
    name: string;
    slug: string;
    confidence: number;
    source: 'ai';
  }>> {
    try {
      const allTags = this.getAllTagsForPrompt();
      
      const prompt = `Given the following content, classify it into the most relevant tags from the provided taxonomy.

Content: "${content}"
Item Type: ${itemType}

Available Tags:
${allTags.map(tag => `- ${tag.name} (${tag.slug})`).join('\n')}

Instructions:
1. Choose up to 3 most relevant tags
2. Rate confidence from 0.0 to 1.0
3. Only include tags with confidence >= 0.7
4. Respond in JSON format: {"tags": [{"name": "...", "slug": "...", "confidence": 0.0}]}

Response:`;

      const response = await this.openai.chat.completions.create({
        model: 'gpt-3.5-turbo', // Cost-effective for classification
        messages: [
          {
            role: 'system',
            content: 'You are a precise content classification system. Always respond with valid JSON.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        max_tokens: 500,
        temperature: 0.1, // Low temperature for consistent results
      });

      const responseText = response.choices[0]?.message?.content || '';
      const parsed = JSON.parse(responseText);

      if (parsed.tags && Array.isArray(parsed.tags)) {
        return parsed.tags
          .filter((tag: any) => 
            tag.name && 
            tag.slug && 
            typeof tag.confidence === 'number' &&
            tag.confidence >= this.CONFIDENCE_THRESHOLD
          )
          .map((tag: any) => ({
            name: tag.name,
            slug: tag.slug,
            confidence: tag.confidence,
            source: 'ai' as const,
          }));
      }

      return [];
    } catch (error) {
      console.error('AI classification failed:', error);
      return [];
    }
  }

  private combineTagResults(
    keywordTags: Array<{ name: string; slug: string; confidence: number; source: 'keyword' }>,
    aiTags: Array<{ name: string; slug: string; confidence: number; source: 'ai' }>
  ): Array<{
    name: string;
    slug: string;
    confidence: number;
    source: 'keyword' | 'ai';
  }> {
    const combined = new Map<string, {
      name: string;
      slug: string;
      confidence: number;
      source: 'keyword' | 'ai';
    }>();

    // Add keyword matches with their confidence
    for (const tag of keywordTags) {
      combined.set(tag.slug, tag);
    }

    // Add AI matches, but boost confidence if both sources agree
    for (const aiTag of aiTags) {
      const existing = combined.get(aiTag.slug);
      if (existing) {
        // Boost confidence if both sources agree
        combined.set(aiTag.slug, {
          ...aiTag,
          confidence: Math.min(existing.confidence + 0.2, 1.0),
        });
      } else {
        combined.set(aiTag.slug, aiTag);
      }
    }

    return Array.from(combined.values())
      .sort((a, b) => b.confidence - a.confidence);
  }

  private getAllTagsForPrompt(): Array<{ name: string; slug: string }> {
    const tags: Array<{ name: string; slug: string }> = [];
    
    for (const category of tagTaxonomy.categories) {
      for (const tag of category.tags) {
        tags.push({
          name: tag.name,
          slug: tag.slug,
        });
      }
    }
    
    return tags;
  }

  private generateCacheKey(request: AutoTagRequest): string {
    const content = `${request.title}|${request.author}|${request.type}`;
    return `autotag:${Buffer.from(content).toString('base64').slice(0, 16)}`;
  }

  private async getCachedTags(cacheKey: string): Promise<AutoTagResult | null> {
    try {
      const cached = await redis.get(cacheKey);
      return cached ? JSON.parse(cached) : null;
    } catch (error) {
      console.error('Failed to get cached tags:', error);
      return null;
    }
  }

  private async cacheTags(cacheKey: string, result: AutoTagResult): Promise<void> {
    try {
      await redis.setex(cacheKey, this.CACHE_TTL, JSON.stringify(result));
    } catch (error) {
      console.error('Failed to cache tags:', error);
    }
  }

  private async storeFeedback(
    itemId: string,
    tagSlug: string,
    accepted: boolean
  ): Promise<void> {
    try {
      // Store in database for analytics and future model training
      await prisma.auditLog.create({
        data: {
          userId: 'system', // System action
          action: accepted ? 'TAG_ACCEPTED' : 'TAG_REJECTED',
          entityType: 'Item',
          entityId: itemId,
        },
      });

      // Track feedback metrics
      const metricsKey = `feedback:tag:${tagSlug}`;
      await redis.incrby(`${metricsKey}:total`, 1);
      await redis.incrby(`${metricsKey}:${accepted ? 'accepted' : 'rejected'}`, 1);
    } catch (error) {
      console.error('Failed to store feedback:', error);
    }
  }

  private async getTotalFeedbackCount(): Promise<number> {
    try {
      const total = await redis.get('feedback:total');
      return total ? parseInt(total) : 0;
    } catch (error) {
      console.error('Failed to get feedback count:', error);
      return 0;
    }
  }

  // Health check for auto-tagging service
  async getHealthStatus(): Promise<{
    healthy: boolean;
    lastError: string | null;
    totalProcessed: number;
    averageConfidence: number;
  }> {
    try {
      // In a real implementation, this would check actual metrics
      return {
        healthy: true,
        lastError: null,
        totalProcessed: 0,
        averageConfidence: 0.8,
      };
    } catch (error) {
      return {
        healthy: false,
        lastError: error instanceof Error ? error.message : 'Unknown error',
        totalProcessed: 0,
        averageConfidence: 0,
      };
    }
  }

  // Get tag suggestion statistics
  async getTagStats(): Promise<{
    totalSuggestions: number;
    acceptanceRate: number;
    topTags: Array<{ slug: string; name: string; count: number }>;
  }> {
    try {
      // This would query actual Redis metrics in production
      return {
        totalSuggestions: 0,
        acceptanceRate: 0,
        topTags: [],
      };
    } catch (error) {
      console.error('Failed to get tag stats:', error);
      return {
        totalSuggestions: 0,
        acceptanceRate: 0,
        topTags: [],
      };
    }
  }
}