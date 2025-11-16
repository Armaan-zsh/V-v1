import OpenAI from 'openai';
import { env } from '../../shared/config/env';

export interface EmbeddingResult {
  embedding: number[];
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export class OpenAIClient {
  private static instance: OpenAI | null = null;
  private static circuitBreaker: {
    failures: number;
    lastFailure: number;
    isOpen: boolean;
    nextRetry: number;
  } = {
    failures: 0,
    lastFailure: 0,
    isOpen: false,
    nextRetry: 0,
  };

  private constructor() {}

  private static getInstance(): OpenAI {
    if (!this.instance) {
      this.instance = new OpenAI({
        apiKey: env.OPENAI_API_KEY,
      });
    }
    return this.instance;
  }

  private static checkCircuitBreaker(): boolean {
    const now = Date.now();
    const { failures, lastFailure, isOpen, nextRetry } = this.circuitBreaker;

    if (isOpen && now < nextRetry) {
      return false;
    }

    if (isOpen && now >= nextRetry) {
      this.circuitBreaker.isOpen = false;
      this.circuitBreaker.failures = 0;
    }

    return true;
  }

  private static updateCircuitBreaker(success: boolean): void {
    if (success) {
      this.circuitBreaker.failures = 0;
      this.circuitBreaker.isOpen = false;
      return;
    }

    this.circuitBreaker.failures++;
    this.circuitBreaker.lastFailure = Date.now();

    if (this.circuitBreaker.failures >= 5) {
      this.circuitBreaker.isOpen = true;
      this.circuitBreaker.nextRetry = Date.now() + (60000 * Math.pow(2, 5)); // Exponential backoff
    }
  }

  static async generateEmbedding(text: string): Promise<EmbeddingResult> {
    if (!this.checkCircuitBreaker()) {
      throw new Error('OpenAI circuit breaker is open');
    }

    try {
      const client = this.getInstance();
      const response = await client.embeddings.create({
        model: 'text-embedding-3-small', // 1536 dimensions as required
        input: text.slice(0, 8191), // OpenAI max input length
      });

      this.updateCircuitBreaker(true);

      return {
        embedding: response.data[0].embedding,
        usage: response.usage ? {
          promptTokens: response.usage.prompt_tokens,
          completionTokens: response.usage.completion_tokens,
          totalTokens: response.usage.total_tokens,
        } : { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
    } catch (error) {
      this.updateCircuitBreaker(false);
      
      if (error instanceof Error) {
        if (error.message.includes('rate limit')) {
          throw new Error('OpenAI rate limit exceeded. Please try again later.');
        }
        if (error.message.includes('quota exceeded')) {
          throw new Error('OpenAI quota exceeded. Please check your billing.');
        }
      }
      
      throw new Error(`OpenAI embedding generation failed: ${error}`);
    }
  }

  static async generateBatchEmbeddings(texts: string[]): Promise<EmbeddingResult[]> {
    if (!this.checkCircuitBreaker()) {
      throw new Error('OpenAI circuit breaker is open');
    }

    try {
      const client = this.getInstance();
      const response = await client.embeddings.create({
        model: 'text-embedding-3-small',
        input: texts.map(text => text.slice(0, 8191)),
      });

      this.updateCircuitBreaker(true);

      return response.data.map((item, index) => ({
        embedding: item.embedding,
        usage: {
          promptTokens: response.usage?.prompt_tokens || 0,
          completionTokens: response.usage?.completion_tokens || 0,
          totalTokens: response.usage?.total_tokens || 0,
        },
      }));
    } catch (error) {
      this.updateCircuitBreaker(false);
      throw new Error(`Batch embedding generation failed: ${error}`);
    }
  }

  static getHealthStatus(): {
    isHealthy: boolean;
    circuitBreakerOpen: boolean;
    failures: number;
  } {
    return {
      isHealthy: !this.circuitBreaker.isOpen && this.circuitBreaker.failures === 0,
      circuitBreakerOpen: this.circuitBreaker.isOpen,
      failures: this.circuitBreaker.failures,
    };
  }

  static resetCircuitBreaker(): void {
    this.circuitBreaker = {
      failures: 0,
      lastFailure: 0,
      isOpen: false,
      nextRetry: 0,
    };
  }
}