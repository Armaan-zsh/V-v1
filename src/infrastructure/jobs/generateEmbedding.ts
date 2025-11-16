import { inngest } from '../inngest/client';
import { OpenAIClient } from '../ai/OpenAIClient';
import { redis } from '../database/redis';
import { prisma } from '../database/prisma';

interface GenerateEmbeddingJobData {
  itemId: string;
  text: string;
  type: 'item' | 'query' | 'user';
  retryCount?: number;
}

const MAX_RETRIES = 3;
const EMBEDDING_CACHE_TTL = 30 * 24 * 60 * 60; // 30 days in seconds

export const generateEmbedding = inngest.createFunction(
  {
    name: 'generate-embedding',
    id: 'generate-embedding',
  },
  { event: 'item.embedding.generate' },
  async ({ event }: { event: { data: GenerateEmbeddingJobData } }) => {
    const { itemId, text, type, retryCount = 0 } = event.data;

    try {
      // Check if embedding already exists in cache
      const cacheKey = `embedding:${type}:${Buffer.from(text).toString('base64')}`;
      const cachedEmbedding = await redis.get(cacheKey);

      if (cachedEmbedding) {
        console.log(`Using cached embedding for ${type} ${itemId}`);
        const embedding = JSON.parse(cachedEmbedding);
        await saveEmbeddingToDatabase(itemId, type, embedding);
        return;
      }

      // Generate new embedding
      console.log(`Generating new embedding for ${type} ${itemId}`);
      const result = await OpenAIClient.generateEmbedding(text);

      // Cache the embedding
      await redis.setex(
        cacheKey,
        EMBEDDING_CACHE_TTL,
        JSON.stringify(result.embedding)
      );

      // Save to database
      await saveEmbeddingToDatabase(itemId, type, result.embedding);

      // Track cost usage
      await trackEmbeddingCost(result.usage.totalTokens);

      console.log(`Successfully generated embedding for ${type} ${itemId}`);
    } catch (error) {
      console.error(`Failed to generate embedding for ${type} ${itemId}:`, error);

      // Retry with exponential backoff
      if (retryCount < MAX_RETRIES) {
        const delayMs = Math.pow(2, retryCount) * 1000; // 1s, 2s, 4s
        await new Promise(resolve => setTimeout(resolve, delayMs));

        await inngest.send({
          name: 'item.embedding.generate',
          data: {
            itemId,
            text,
            type,
            retryCount: retryCount + 1,
          },
        });
      } else {
        // Mark as failed, don't block item creation
        await markEmbeddingGenerationFailed(itemId, type, error);
      }
    }
  }
);

async function saveEmbeddingToDatabase(
  itemId: string,
  type: string,
  embedding: number[]
): Promise<void> {
  try {
    if (type === 'item') {
      // Update item with embedding
      await prisma.item.update({
        where: { id: itemId },
        data: {
          embedding: JSON.stringify(embedding),
          embeddingGeneratedAt: new Date(),
        },
      });
    } else if (type === 'user') {
      // Update user profile embedding
      await prisma.user.update({
        where: { id: itemId },
        data: {
          profileEmbedding: JSON.stringify(embedding),
          profileEmbeddingGeneratedAt: new Date(),
        },
      });
    }
  } catch (error) {
    console.error(`Failed to save embedding to database for ${type} ${itemId}:`, error);
    throw error;
  }
}

async function markEmbeddingGenerationFailed(
  itemId: string,
  type: string,
  error: unknown
): Promise<void> {
  try {
    if (type === 'item') {
      await prisma.item.update({
        where: { id: itemId },
        data: {
          embeddingGenerationError: error instanceof Error ? error.message : 'Unknown error',
        },
      });
    } else if (type === 'user') {
      await prisma.user.update({
        where: { id: itemId },
        data: {
          profileEmbeddingGenerationError: error instanceof Error ? error.message : 'Unknown error',
        },
      });
    }
  } catch (dbError) {
    console.error(`Failed to mark embedding generation as failed:`, dbError);
  }
}

async function trackEmbeddingCost(tokensUsed: number): Promise<void> {
  try {
    // Track cost in PostHog or database for cost monitoring
    const cost = (tokensUsed / 1000) * 0.0001; // $0.0001 per 1K tokens for text-embedding-3-small
    
    await redis.incrbyfloat('cost:embeddings:total', cost);
    await redis.incrby('cost:embeddings:count', 1);
    
    // Daily tracking
    const today = new Date().toISOString().split('T')[0];
    await redis.incrbyfloat(`cost:embeddings:daily:${today}`, cost);
  } catch (error) {
    console.error('Failed to track embedding cost:', error);
  }
}

// Helper function to trigger embedding generation
export async function triggerEmbeddingGeneration(
  itemId: string,
  text: string,
  type: 'item' | 'user' = 'item'
): Promise<void> {
  await inngest.send({
    name: 'item.embedding.generate',
    data: {
      itemId,
      text,
      type,
    },
  });
}

// Bulk trigger for batch processing
export async function triggerBulkEmbeddingGeneration(
  items: Array<{ id: string; text: string; type: 'item' | 'user' }>
): Promise<void> {
  for (const item of items) {
    await triggerEmbeddingGeneration(item.id, item.text, item.type);
  }
}