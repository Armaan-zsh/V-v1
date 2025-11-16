import { z } from 'zod';

/**
 * Environment validation schema for Vow application
 * Ensures all required environment variables are present and properly formatted
 */

// Create Zod schema with strict mode to catch extra variables
export const envSchema = z.object({
  // Database
  DATABASE_URL: z.string().url('DATABASE_URL must be a valid URL'),
  
  // NextAuth
  NEXTAUTH_SECRET: z.string().min(32, 'NEXTAUTH_SECRET must be at least 32 characters'),
  NEXTAUTH_URL: z.string().url('NEXTAUTH_URL must be a valid URL').optional(),
  
  // OAuth Providers
  GOOGLE_CLIENT_ID: z.string().min(1, 'GOOGLE_CLIENT_ID is required'),
  GOOGLE_CLIENT_SECRET: z.string().min(1, 'GOOGLE_CLIENT_SECRET is required'),
  APPLE_CLIENT_ID: z.string().min(1, 'APPLE_CLIENT_ID is required'),
  APPLE_PRIVATE_KEY: z.string().min(1, 'APPLE_PRIVATE_KEY is required'),
  
  // Twilio (for SMS)
  TWILIO_ACCOUNT_SID: z.string().min(1, 'TWILIO_ACCOUNT_SID is required'),
  TWILIO_AUTH_TOKEN: z.string().min(1, 'TWILIO_AUTH_TOKEN is required'),
  TWILIO_PHONE_NUMBER: z.string().regex(/^\+[1-9]\d{1,14}$/, 'TWILIO_PHONE_NUMBER must be in E.164 format'),
  
  // Redis (Upstash)
  UPSTASH_REDIS_URL: z.string().url('UPSTASH_REDIS_URL must be a valid URL'),
  UPSTASH_REDIS_TOKEN: z.string().min(1, 'UPSTASH_REDIS_TOKEN is required'),
  
  // Supabase
  SUPABASE_URL: z.string().url('SUPABASE_URL must be a valid URL'),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, 'SUPABASE_SERVICE_ROLE_KEY is required'),
  SUPABASE_ANON_KEY: z.string().min(1, 'SUPABASE_ANON_KEY is required'),
  
  // Monitoring
  SENTRY_DSN: z.string().url('SENTRY_DSN must be a valid URL').optional(),
  
  // Analytics
  POSTHOG_KEY: z.string().min(1, 'POSTHOG_KEY is required'),
  POSTHOG_HOST: z.string().url('POSTHOG_HOST must be a valid URL').default('https://app.posthog.com'),
  
  // Inngest (Background Jobs)
  INNGEST_EVENT_KEY: z.string().min(1, 'INNGEST_EVENT_KEY is required'),
  INNGEST_SIGNING_KEY: z.string().min(1, 'INNGEST_SIGNING_KEY is required'),
  
  // External APIs
  GOOGLE_BOOKS_API_KEY: z.string().min(1, 'GOOGLE_BOOKS_API_KEY is required').optional(),
  CROSSREF_API_KEY: z.string().min(1, 'CROSSREF_API_KEY is required').optional(),
  ARXIV_API_KEY: z.string().min(1, 'ARXIV_API_KEY is required').optional(),
  
  // AI/ML Services
  OPENAI_API_KEY: z.string().min(1, 'OPENAI_API_KEY is required'),
  GROQ_API_KEY: z.string().min(1, 'GROQ_API_KEY is required').optional(),
  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY is required').optional(),
  
  // Redis (using standard names)
  REDIS_URL: z.string().url('REDIS_URL must be a valid URL'),
  REDIS_TOKEN: z.string().min(1, 'REDIS_TOKEN is required'),
  
  // Application
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_URL: z.string().url('APP_URL must be a valid URL').default('http://localhost:3000'),
}).strict('Unexpected environment variables detected');

/**
 * Custom error for environment validation failures
 */
export class EnvValidationError extends Error {
  constructor(message: string, public readonly missingKeys: string[] = []) {
    super(message);
    this.name = 'EnvValidationError';
  }
}

/**
 * Validate and parse environment variables
 */
export function validateEnvironment(): z.infer<typeof envSchema> {
  try {
    return envSchema.parse(process.env);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const missingKeys = error.issues.map(issue => issue.path.join('.'));
      const message = `Environment validation failed:\n${error.issues
        .map(issue => `  ${issue.path.join('.')}: ${issue.message}`)
        .join('\n')}`;
      
      throw new EnvValidationError(message, missingKeys);
    }
    throw error;
  }
}

/**
 * Mask secrets in error logs for security
 */
export function maskSecret(key: string, value: string): string {
  if (!value) return '';
  if (key.includes('SECRET') || key.includes('KEY') || key.includes('TOKEN')) {
    return `${'*'.repeat(Math.max(8, value.length - 4))}${value.slice(-4)}`;
  }
  return value;
}

/**
 * Type for validated environment variables
 */
export type Env = z.infer<typeof envSchema>;

// Export validated environment (will throw on import if invalid)
export const env = validateEnvironment();
